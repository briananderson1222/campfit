/**
 * tests/integration/scheduled-run-monitor-parity.test.ts — campfit#92 AC4
 * acceptance evidence for the schedule panel (Wave 3): a real `CrawlRun`
 * with `trigger = 'SCHEDULED'` (seeded via `lib/admin/crawl-repository.ts`'s
 * own `createCrawlRun`/`updateCrawlRunProgress`/`completeCrawlRun` — the
 * exact seam `runCrawlPipeline`'s tracker already uses, not hand-rolled SQL)
 * round-trips through `GET /api/admin/crawl/list` and
 * `GET /api/admin/crawl/[runId]/status-json` with the SAME shape a `MANUAL`
 * run gets — the data the new schedule panel's own "Last run" readout
 * depends on (`app/admin/crawls/schedule-panel.tsx`), even though the
 * panel's own client-side rendering isn't test-executable here (no jsdom/
 * testing-library harness in this repo — campfit#96, see
 * `schedule-panel-view.test.ts`'s header doc for the same note).
 *
 * Against the real `TEST_DATABASE_URL`, mirroring
 * `admin-crawl-schedule-route.test.ts`'s `requireAdminAccess`-mock-at-the-
 * import-boundary shape. `app/api/admin/crawl/list/route.ts` and
 * `app/api/admin/crawl/[runId]/status-json/route.ts` are exercised for
 * real — no trigger-conditional code path exists in either to diverge (per
 * `app/api/admin/crawl/list/route.ts`'s own unfiltered
 * `SELECT * FROM "CrawlRun"`), so this test is a regression guard, not a
 * behavior change.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

import { createCrawlRun, updateCrawlRunProgress, completeCrawlRun } from '@/lib/admin/crawl-repository';
import { GET as listGet } from '@/app/api/admin/crawl/list/route';
import { GET as statusJsonGet } from '@/app/api/admin/crawl/[runId]/status-json/route';

const ADMIN_ACCESS = {
  access: {
    userId: 'test-admin',
    email: 'admin@campfit.test',
    isAdmin: true,
    isModerator: false,
    communities: [],
  },
};

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
});

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "CrawlRun" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

async function seedCompletedScheduledRun(): Promise<string> {
  const run = await createCrawlRun({
    triggeredBy: 'cron:scheduled-crawl',
    trigger: 'SCHEDULED',
    campIds: undefined,
    totalCamps: 2,
  });
  await updateCrawlRunProgress(run.id, { processedCamps: 2, newProposals: 1, errorCount: 0 });
  await completeCrawlRun(run.id, 'COMPLETED', []);
  return run.id;
}

async function seedCompletedManualRun(): Promise<string> {
  const run = await createCrawlRun({
    triggeredBy: 'admin@campfit.test',
    trigger: 'MANUAL',
    campIds: undefined,
    totalCamps: 3,
  });
  await updateCrawlRunProgress(run.id, { processedCamps: 3, newProposals: 0, errorCount: 0 });
  await completeCrawlRun(run.id, 'COMPLETED', []);
  return run.id;
}

describe('SCHEDULED CrawlRun — parity with MANUAL through GET /api/admin/crawl/list (AC4)', () => {
  it('appears in the run list with the same fields shape as a MANUAL run, trigger unfiltered', async () => {
    const scheduledId = await seedCompletedScheduledRun();
    const manualId = await seedCompletedManualRun();

    const res = await listGet();
    expect(res.status).toBe(200);
    const data = await res.json();

    const scheduledRun = data.runs.find((r: { id: string }) => r.id === scheduledId);
    const manualRun = data.runs.find((r: { id: string }) => r.id === manualId);

    expect(scheduledRun).toBeDefined();
    expect(manualRun).toBeDefined();
    expect(scheduledRun.trigger).toBe('SCHEDULED');
    expect(manualRun.trigger).toBe('MANUAL');

    // Same field shape on both — no trigger-conditional divergence.
    const scheduledKeys = Object.keys(scheduledRun).sort();
    const manualKeys = Object.keys(manualRun).sort();
    expect(scheduledKeys).toEqual(manualKeys);

    expect(scheduledRun.status).toBe('COMPLETED');
    expect(scheduledRun.processedCamps).toBe(2);
    expect(scheduledRun.totalCamps).toBe(2);
    expect(scheduledRun.newProposals).toBe(1);
    expect(scheduledRun.triggeredBy).toBe('cron:scheduled-crawl');
  });
});

describe('SCHEDULED CrawlRun — parity with MANUAL through GET /api/admin/crawl/[runId]/status-json (AC4)', () => {
  it('returns the same response shape/fields for a SCHEDULED run as for a MANUAL run', async () => {
    const scheduledId = await seedCompletedScheduledRun();
    const manualId = await seedCompletedManualRun();

    const scheduledRes = await statusJsonGet(
      new Request(`http://localhost/api/admin/crawl/${scheduledId}/status-json`),
      { params: Promise.resolve({ runId: scheduledId }) },
    );
    const manualRes = await statusJsonGet(
      new Request(`http://localhost/api/admin/crawl/${manualId}/status-json`),
      { params: Promise.resolve({ runId: manualId }) },
    );

    expect(scheduledRes.status).toBe(200);
    expect(manualRes.status).toBe(200);

    const scheduledData = await scheduledRes.json();
    const manualData = await manualRes.json();

    expect(Object.keys(scheduledData).sort()).toEqual(Object.keys(manualData).sort());
    expect(scheduledData.trigger).toBe('SCHEDULED');
    expect(scheduledData.status).toBe('COMPLETED');
    expect(scheduledData.processedCamps).toBe(2);
    expect(scheduledData.totalCamps).toBe(2);
    expect(scheduledData.newProposals).toBe(1);
  });

  it('a 401/403 unauthorized caller is rejected identically for a SCHEDULED run as for any other trigger', async () => {
    const scheduledId = await seedCompletedScheduledRun();
    requireAdminAccessMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await statusJsonGet(
      new Request(`http://localhost/api/admin/crawl/${scheduledId}/status-json`),
      { params: Promise.resolve({ runId: scheduledId }) },
    );
    expect(res.status).toBe(401);
  });
});
