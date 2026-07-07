/**
 * tests/integration/batch-accept-route.test.ts — end-to-end HTTP coverage
 * for `POST /api/admin/review/batch-accept` (campfit#51, Wave 3 Task 3.1,
 * R2/R3/R4/AC2/AC3), against the real throwaway Postgres and a mocked
 * `requireAdminAccess` (following `camp-create.test.ts`'s
 * `mockAsModerator`/`evaluateAdminAccess` real-auth-logic pattern — no
 * mocked authorization DECISION, only the Supabase user lookup).
 *
 * (a) is the explicit #93-lesson fault-injection test named by the plan: a
 * moderator scoped to community A submitting one in-scope and one
 * out-of-scope selection in the SAME request — the in-scope one applies,
 * the out-of-scope one comes back `excluded_scope`, and a real DB check
 * confirms the out-of-scope Camp row was never touched.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return { ...actual, requireAdminAccess: requireAdminAccessMock };
});

import { evaluateAdminAccess } from '@/lib/admin/access';
import { getPool as getProductionPool } from '@/lib/db';
import { getBatchAcceptAudit } from '@/lib/admin/batch-accept-audit-repository';
import { POST } from '@/app/api/admin/review/batch-accept/route';

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

function mockAsAdmin() {
  requireAdminAccessMock.mockResolvedValue({
    access: { userId: 'admin-1', email: 'admin@campfit.test', isAdmin: true, isModerator: false, communities: [] },
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/review/batch-accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertCamp(pool: Pool, overrides: { communitySlug?: string; city?: string } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, "communitySlug", city)
     VALUES ($1, $2, 'SUMMER_DAY', 'SPORTS', $3, $4)
     RETURNING id`,
    [`test-camp-${randomUUID()}`, 'Test Camp', overrides.communitySlug ?? 'denver', overrides.city ?? ''],
  );
  return result.rows[0]!.id;
}

async function insertCrawlRun(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`INSERT INTO "CrawlRun" (status) VALUES ('COMPLETED') RETURNING id`);
  return result.rows[0]!.id;
}

async function insertProposal(pool: Pool, opts: {
  campId: string;
  field: string;
  value: string;
  crawlRunId: string;
  status?: 'PENDING' | 'APPROVED';
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "crawlRunId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status)
     VALUES ($1, $2, 'https://example.test/camp', $3::jsonb, 0.9, 'test-extraction-model', $4)
     RETURNING id`,
    [
      opts.campId,
      opts.crawlRunId,
      JSON.stringify({ [opts.field]: { old: '', new: opts.value, confidence: 0.9, sourceUrl: 'https://example.test/camp' } }),
      opts.status ?? 'PENDING',
    ],
  );
  return result.rows[0]!.id;
}

/** Seeds a resolved, different-crawlRunId corroborating sibling for `field`/`value` on `campId`. */
async function seedCorroboratingHistory(pool: Pool, campId: string, field: string, value: string): Promise<void> {
  const runId = await insertCrawlRun(pool);
  await insertProposal(pool, { campId, field, value, crawlRunId: runId, status: 'APPROVED' });
}

async function queryCampField(pool: Pool, campId: string, field: 'city'): Promise<string> {
  const { rows } = await pool.query(`SELECT "${field}" AS value FROM "Camp" WHERE id = $1`, [campId]);
  return rows[0]?.value;
}

describe('POST /api/admin/review/batch-accept', () => {
  let pool: Pool;

  beforeAll(async () => {
    await assertTestDatabase();
    pool = getTestPool();
  });

  afterEach(async () => {
    await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
    await pool.query(`TRUNCATE "CrawlMetric";`);
    await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
    await pool.query(`TRUNCATE "ReviewBatchAcceptAudit";`);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestPool();
    await getProductionPool().end();
  });

  it('(a) #93-lesson fault injection: a moderator scoped to community A gets excluded_scope for a community-B selection, and that Camp row is never touched, while the in-scope selection still applies', async () => {
    mockAsModerator('denver');

    const campA = await insertCamp(pool, { communitySlug: 'denver', city: '' });
    const runA = await insertCrawlRun(pool);
    const proposalA = await insertProposal(pool, { campId: campA, field: 'city', value: 'Austin', crawlRunId: runA });
    await seedCorroboratingHistory(pool, campA, 'city', 'Austin');

    const campB = await insertCamp(pool, { communitySlug: 'boulder', city: '' });
    const runB = await insertCrawlRun(pool);
    const proposalB = await insertProposal(pool, { campId: campB, field: 'city', value: 'Golden', crawlRunId: runB });
    await seedCorroboratingHistory(pool, campB, 'city', 'Golden');

    const res = await POST(postRequest({
      selections: [
        { proposalId: proposalA, field: 'city' },
        { proposalId: proposalB, field: 'city' },
      ],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();

    const resultA = body.results.find((r: { proposalId: string }) => r.proposalId === proposalA);
    const resultB = body.results.find((r: { proposalId: string }) => r.proposalId === proposalB);
    expect(resultA.status).toBe('applied');
    expect(resultB.status).toBe('excluded_scope');

    expect(await queryCampField(pool, campA, 'city')).toBe('Austin');
    // The out-of-scope Camp row was NEVER touched.
    expect(await queryCampField(pool, campB, 'city')).toBe('');

    expect(body.auditId).not.toBeNull();
    const audit = await getBatchAcceptAudit(body.auditId, pool);
    expect(audit!.claims.map((c: { proposalId: string }) => c.proposalId)).toEqual([proposalA]);
    expect(audit!.excluded.some((e: { proposalId: string; reason: string }) => e.proposalId === proposalB && e.reason === 'out_of_scope')).toBe(true);
  });

  it('(b) a selection whose field is not corroborated comes back excluded_not_corroborated (route-level end-to-end), and STILL gets an audit row (REVIEW M4)', async () => {
    mockAsAdmin();
    const campId = await insertCamp(pool, { city: '' });
    const runId = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, { campId, field: 'city', value: 'Austin', crawlRunId: runId });
    // No corroborating history seeded.

    const res = await POST(postRequest({ selections: [{ proposalId, field: 'city' }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{ proposalId, field: 'city', status: 'excluded_not_corroborated', message: expect.any(String) }]);
    expect(await queryCampField(pool, campId, 'city')).toBe('');

    // REVIEW M4 FIX: nothing applied, but this is a 100%-excluded batch —
    // an audit row must still be written (forensic trace of the attempt),
    // with acceptedCount (claims.length) 0 and the exclusion recorded.
    expect(body.auditId).not.toBeNull();
    const audit = await getBatchAcceptAudit(body.auditId, pool);
    expect(audit!.appliedCount).toBe(0);
    expect(audit!.claims).toEqual([]);
    expect(audit!.excluded).toEqual([
      { proposalId, field: 'city', reason: 'not_corroborated', message: expect.any(String) },
    ]);
  });

  it('(b2) REVIEW M4: a fully-out-of-scope batch (every selection excluded_scope) still gets a 200 with a per-selection result AND an audit row (acceptedCount 0, exclusions recorded) — a forensic trace of the scope-violation attempt', async () => {
    mockAsModerator('denver');

    const campB = await insertCamp(pool, { communitySlug: 'boulder', city: '' });
    const runB = await insertCrawlRun(pool);
    const proposalB = await insertProposal(pool, { campId: campB, field: 'city', value: 'Golden', crawlRunId: runB });
    await seedCorroboratingHistory(pool, campB, 'city', 'Golden');

    const res = await POST(postRequest({ selections: [{ proposalId: proposalB, field: 'city' }] }));

    // Response shape unchanged from before this fix: 200, one excluded_scope result.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { proposalId: proposalB, field: 'city', status: 'excluded_scope', message: expect.any(String) },
    ]);
    expect(await queryCampField(pool, campB, 'city')).toBe('');

    expect(body.auditId).not.toBeNull();
    const audit = await getBatchAcceptAudit(body.auditId, pool);
    expect(audit!.appliedCount).toBe(0);
    expect(audit!.claims).toEqual([]);
    expect(audit!.excluded).toEqual([
      { proposalId: proposalB, field: 'city', reason: 'out_of_scope', message: expect.any(String) },
    ]);
  });

  it('(c) a non-admin/non-moderator request returns 401/403 with zero DB writes', async () => {
    requireAdminAccessMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const campId = await insertCamp(pool, { city: '' });
    const runId = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, { campId, field: 'city', value: 'Austin', crawlRunId: runId });
    await seedCorroboratingHistory(pool, campId, 'city', 'Austin');

    const res = await POST(postRequest({ selections: [{ proposalId, field: 'city' }] }));
    expect(res.status).toBe(401);
    expect(await queryCampField(pool, campId, 'city')).toBe('');

    const auditRows = await pool.query(`SELECT COUNT(*)::int AS count FROM "ReviewBatchAcceptAudit"`);
    expect(auditRows.rows[0].count).toBe(0);
  });

  it('a moderator with no matching community assignment (forbidden) returns 403', async () => {
    requireAdminAccessMock.mockImplementation(
      async (opts?: { communitySlug?: string | null; allowModerator?: boolean }) =>
        evaluateAdminAccess({
          userId: 'user-1',
          email: 'user@campfit.test',
          isAdmin: false,
          assignments: [],
          requestedCommunity: opts?.communitySlug,
          allowModerator: opts?.allowModerator,
        }),
    );

    const res = await POST(postRequest({ selections: [{ proposalId: randomUUID(), field: 'city' }] }));
    expect(res.status).toBe(403);
  });

  it('(d) the response auditId resolves via getBatchAcceptAudit to a row whose claims/excluded exactly match the response\'s own results', async () => {
    mockAsAdmin();

    const camp1 = await insertCamp(pool, { city: '' });
    const run1 = await insertCrawlRun(pool);
    const proposal1 = await insertProposal(pool, { campId: camp1, field: 'city', value: 'Austin', crawlRunId: run1 });
    await seedCorroboratingHistory(pool, camp1, 'city', 'Austin');

    const camp2 = await insertCamp(pool, { city: '' });
    const run2 = await insertCrawlRun(pool);
    const proposal2 = await insertProposal(pool, { campId: camp2, field: 'city', value: 'Denver' , crawlRunId: run2 });
    // No corroboration for proposal2 -> excluded_not_corroborated.

    const res = await POST(postRequest({
      selections: [
        { proposalId: proposal1, field: 'city' },
        { proposalId: proposal2, field: 'city' },
      ],
    }));
    const body = await res.json();
    expect(body.auditId).not.toBeNull();

    const audit = await getBatchAcceptAudit(body.auditId, pool);
    const appliedResults = body.results.filter((r: { status: string }) => r.status === 'applied');
    const excludedResults = body.results.filter((r: { status: string }) => r.status !== 'applied');

    expect(audit!.claims.map((c: { proposalId: string; field: string }) => ({ proposalId: c.proposalId, field: c.field })))
      .toEqual(appliedResults.map((r: { proposalId: string; field: string }) => ({ proposalId: r.proposalId, field: r.field })));
    expect(audit!.excluded.map((e: { proposalId: string; field: string }) => ({ proposalId: e.proposalId, field: e.field })))
      .toEqual(excludedResults.map((r: { proposalId: string; field: string }) => ({ proposalId: r.proposalId, field: r.field })));
  });
});
