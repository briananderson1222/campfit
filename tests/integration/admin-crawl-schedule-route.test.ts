/**
 * tests/integration/admin-crawl-schedule-route.test.ts — campfit#92 Wave 2
 * acceptance evidence for `GET`/`PATCH /api/admin/crawl-schedule`.
 *
 * Against the real `TEST_DATABASE_URL` (`test-db.ts`'s `assertTestDatabase()`
 * convention), with `requireAdminAccess` mocked at the import boundary
 * (backed by the real, unmocked `evaluateAdminAccess` for the moderator/
 * non-admin cases) — the same shape `provider-create.test.ts` established.
 * The route's own SQL and `lib/admin/schedule-repository.ts`
 * (`getSchedule`/`updateSchedule`) are exercised for real.
 *
 * Coverage:
 *  - AC2 (R2): GET returns defaults on a fresh schedule row; PATCH persists
 *    `enabled`/`priority`/`batchSize` and a subsequent GET reflects it;
 *    PATCH with a `batchSize`/`priority` outside the allowed set is
 *    rejected 400 and does NOT mutate the row; `lastRun` reflects a seeded
 *    `SCHEDULED` `CrawlRun` and ignores a more-recent `MANUAL` one.
 *  - Auth: 401 with no session, 403 for a non-admin (moderator) caller —
 *    the schedule is a single global toggle (admin-only, no
 *    `allowModerator`), matching the plan's explicit decision.
 *
 * Because `CrawlSchedule` is a real singleton row (not truncatable without
 * breaking the migration's `id = 'default'` bootstrap invariant other tests
 * may also depend on), `afterEach` resets it back to the migration's own
 * default values rather than truncating the table.
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

import { evaluateAdminAccess } from '@/lib/admin/access';
import { GET, PATCH } from '@/app/api/admin/crawl-schedule/route';

const ADMIN_ACCESS = {
  access: {
    userId: 'test-admin',
    email: 'admin@campfit.test',
    isAdmin: true,
    isModerator: false,
    communities: ['denver'],
  },
};

/** Simulates a real (non-admin) moderator via the actual `evaluateAdminAccess`. */
function mockAsModerator(communitySlug: string) {
  requireAdminAccessMock.mockImplementation(
    async (opts?: { communitySlug?: string | null; allowModerator?: boolean }) =>
      evaluateAdminAccess({
        userId: `mod-${communitySlug}`,
        email: `moderator@${communitySlug}.test`,
        isAdmin: false,
        assignments: [{ communitySlug, role: 'MODERATOR' }],
        requestedCommunity: opts?.communitySlug,
        allowModerator: opts?.allowModerator,
      }),
  );
}

function mockUnauthenticated() {
  requireAdminAccessMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
}

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
  // Reset the singleton row back to the migration's own defaults instead of
  // truncating (the table's CHECK constraint + bootstrap insert mean a
  // truncate would just re-require a re-provision to get the row back).
  await pool.query(
    `UPDATE "CrawlSchedule" SET enabled = false, priority = 'stale', "batchSize" = 5, "updatedBy" = NULL WHERE id = 'default'`,
  );
  await pool.query(`TRUNCATE "CrawlRun" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

function getRequest(): Request {
  return new Request('http://localhost/api/admin/crawl-schedule', { method: 'GET' });
}

function patchRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/crawl-schedule', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertCrawlRun(input: {
  trigger: 'MANUAL' | 'SCHEDULED';
  startedAt: Date;
  status?: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "CrawlRun" (trigger, "startedAt", status)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.trigger, input.startedAt, input.status ?? 'COMPLETED'],
  );
  return rows[0].id;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('auth — GET/PATCH /api/admin/crawl-schedule', () => {
  it('GET rejects an unauthenticated caller with 401', async () => {
    mockUnauthenticated();
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('GET rejects a non-admin moderator with 403 (admin-only, no allowModerator)', async () => {
    mockAsModerator('denver');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('PATCH rejects an unauthenticated caller with 401 and does not mutate the row', async () => {
    mockUnauthenticated();
    const res = await PATCH(patchRequest({ enabled: true }));
    expect(res.status).toBe(401);
    const { rows } = await pool.query(`SELECT enabled FROM "CrawlSchedule" WHERE id = 'default'`);
    expect(rows[0].enabled).toBe(false);
  });

  it('PATCH rejects a non-admin moderator with 403 and does not mutate the row', async () => {
    mockAsModerator('denver');
    const res = await PATCH(patchRequest({ enabled: true }));
    expect(res.status).toBe(403);
    const { rows } = await pool.query(`SELECT enabled FROM "CrawlSchedule" WHERE id = 'default'`);
    expect(rows[0].enabled).toBe(false);
  });
});

// ── GET ──────────────────────────────────────────────────────────────────────

describe('GET /api/admin/crawl-schedule', () => {
  it('returns the schedule defaults, a null lastRun, and a computed nextRun on a fresh row', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.schedule).toMatchObject({
      id: 'default',
      enabled: false,
      priority: 'stale',
      batchSize: 5,
      updatedBy: null,
    });
    expect(data.lastRun).toBeNull();
    expect(data.nextRun).toBeTruthy();
    expect(new Date(data.nextRun).getTime()).toBeGreaterThan(Date.now());
  });

  it('lastRun reflects the most recent SCHEDULED CrawlRun and ignores a more-recent MANUAL one', async () => {
    const scheduledId = await insertCrawlRun({
      trigger: 'SCHEDULED',
      startedAt: new Date(Date.now() - 60_000),
    });
    // A MANUAL run started AFTER the scheduled one — must be ignored by lastRun.
    await insertCrawlRun({ trigger: 'MANUAL', startedAt: new Date() });

    const res = await GET();
    const data = await res.json();
    expect(data.lastRun?.id).toBe(scheduledId);
    expect(data.lastRun?.trigger).toBe('SCHEDULED');
  });

  it('lastRun picks the most recent of multiple SCHEDULED runs', async () => {
    await insertCrawlRun({ trigger: 'SCHEDULED', startedAt: new Date(Date.now() - 120_000) });
    const latestId = await insertCrawlRun({ trigger: 'SCHEDULED', startedAt: new Date(Date.now() - 30_000) });

    const res = await GET();
    const data = await res.json();
    expect(data.lastRun?.id).toBe(latestId);
  });
});

// ── PATCH ────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/crawl-schedule', () => {
  it('persists enabled/priority/batchSize together and a subsequent GET reflects it', async () => {
    const patchRes = await PATCH(patchRequest({ enabled: true, priority: 'never_crawled', batchSize: 10 }));
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.schedule).toMatchObject({
      enabled: true,
      priority: 'never_crawled',
      batchSize: 10,
      updatedBy: 'admin@campfit.test',
    });

    const getRes = await GET();
    const getData = await getRes.json();
    expect(getData.schedule).toMatchObject({
      enabled: true,
      priority: 'never_crawled',
      batchSize: 10,
      updatedBy: 'admin@campfit.test',
    });
  });

  it('persists a single-field patch without touching the others', async () => {
    await PATCH(patchRequest({ priority: 'never_crawled', batchSize: 10 }));
    const res = await PATCH(patchRequest({ enabled: true }));
    const data = await res.json();
    expect(data.schedule.enabled).toBe(true);
    expect(data.schedule.priority).toBe('never_crawled');
    expect(data.schedule.batchSize).toBe(10);
  });

  it('rejects a batchSize outside {5, 10} with 400 and does not mutate the row', async () => {
    const res = await PATCH(patchRequest({ batchSize: 20 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/batchSize/i);

    const { rows } = await pool.query(`SELECT "batchSize" FROM "CrawlSchedule" WHERE id = 'default'`);
    expect(rows[0].batchSize).toBe(5);
  });

  it('rejects a priority outside {stale, never_crawled} with 400 and does not mutate the row', async () => {
    const res = await PATCH(patchRequest({ priority: 'coming_soon' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/priority/i);

    const { rows } = await pool.query(`SELECT priority FROM "CrawlSchedule" WHERE id = 'default'`);
    expect(rows[0].priority).toBe('stale');
  });

  it('rejects a non-boolean enabled with 400 and does not mutate the row', async () => {
    const res = await PATCH(patchRequest({ enabled: 'yes' }));
    expect(res.status).toBe(400);

    const { rows } = await pool.query(`SELECT enabled FROM "CrawlSchedule" WHERE id = 'default'`);
    expect(rows[0].enabled).toBe(false);
  });

  it('stamps updatedBy from the caller’s session, not a client-supplied value', async () => {
    const res = await PATCH(patchRequest({ enabled: true, updatedBy: 'someone-else@evil.test' }));
    const data = await res.json();
    expect(data.schedule.updatedBy).toBe('admin@campfit.test');
  });
});
