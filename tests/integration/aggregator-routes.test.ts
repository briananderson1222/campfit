/**
 * tests/integration/aggregator-routes.test.ts — campfit#93 Wave 3, Task 3.2
 * acceptance suite for the `AggregatorSource` registration/list/detail/
 * ToS-decision routes (R1/AC1).
 *
 * Against the real `TEST_DATABASE_URL` (`test-db.ts`'s `assertTestDatabase()`
 * convention), with `requireAdminAccess` mocked at the import boundary
 * (backed by the real, unmocked `evaluateAdminAccess` for the moderator/
 * non-admin cases) — the SAME shape `provider-create.test.ts` /
 * `admin-crawl-schedule-route.test.ts` established. The routes' own SQL and
 * `lib/ingestion/aggregator/aggregator-repository.ts` are exercised for
 * real; `crawlSource`/`extract()` are never touched by this suite (that is
 * `aggregator-extraction.test.ts`'s and `aggregator-discover-onboard-routes
 * .test.ts`'s job).
 *
 * Coverage:
 *  - `POST /api/admin/aggregators` — 201 with status:'REGISTERED',
 *    tosDecision:null on a valid create; 400 for a missing name or an
 *    invalid url; creates no row on either 400.
 *  - `GET /api/admin/aggregators?community=` — scoped by community; each
 *    row carries a `pendingCandidateCount` rollup (0 with no candidates,
 *    correct count once PENDING ProviderCandidate rows are seeded against
 *    it — APPROVED/REJECTED rows for the same aggregator must NOT count).
 *  - `GET /api/admin/aggregators/[id]` — 404 for an unknown id; 200 with the
 *    full row for a known one.
 *  - `POST /api/admin/aggregators/[id]/tos-decision` — flips
 *    status/tosDecision correctly for both APPROVED and DECLINED; requires
 *    ADMIN auth (not moderator — no allowModerator on this route, unlike its
 *    siblings); 400 for an invalid decision value; 404 for an unknown id.
 *  - Auth ordering: an unauthorized/unauthenticated caller against a
 *    NONEXISTENT id still gets the auth error, not a 404 (never leak
 *    existence pre-auth) — mirrors `providers/[providerId]/route.ts`'s own
 *    ordering, asserted directly here since this plan calls it out as a
 *    "requireAdminAccess ordering" concern.
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
import { GET as listGET, POST as registerPOST } from '@/app/api/admin/aggregators/route';
import { GET as detailGET } from '@/app/api/admin/aggregators/[id]/route';
import { POST as tosDecisionPOST } from '@/app/api/admin/aggregators/[id]/tos-decision/route';
import {
  createAggregatorSource,
  ensureAggregatorSourceSchema,
} from '@/lib/ingestion/aggregator/aggregator-repository';
import { enqueueCandidate, ensureProviderCandidateSchema } from '@/lib/ingestion/discovery/candidate-repository';

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
  await ensureAggregatorSourceSchema(pool);
  await ensureProviderCandidateSchema(pool);
});

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "ProviderCandidate", "AggregatorSource" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function detailParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function aggregatorCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "AggregatorSource"`);
  return Number(rows[0].count);
}

// ── POST /api/admin/aggregators (register) ─────────────────────────────────

describe('POST /api/admin/aggregators', () => {
  it('registers a new aggregator with status REGISTERED and tosDecision null', async () => {
    const res = await registerPOST(
      jsonRequest('http://localhost/api/admin/aggregators', 'POST', {
        name: 'Camp Finder Directory',
        url: 'https://campfinder.example',
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.status).toBe('REGISTERED');
    expect(data.tosDecision).toBeNull();
    expect(data.communitySlug).toBe('denver');
    expect(data.createdBy).toBe('admin@campfit.test');
    expect(await aggregatorCount()).toBe(1);
  });

  it('rejects a missing name with 400 and creates no row', async () => {
    const res = await registerPOST(
      jsonRequest('http://localhost/api/admin/aggregators', 'POST', { url: 'https://campfinder.example' }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/name/i);
    expect(await aggregatorCount()).toBe(0);
  });

  it('rejects an invalid url with 400 and creates no row', async () => {
    const res = await registerPOST(
      jsonRequest('http://localhost/api/admin/aggregators', 'POST', { name: 'Bad URL Aggregator', url: 'not a url' }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/valid http/i);
    expect(await aggregatorCount()).toBe(0);
  });

  it('rejects an empty url with 400 and creates no row', async () => {
    const res = await registerPOST(
      jsonRequest('http://localhost/api/admin/aggregators', 'POST', { name: 'No URL Aggregator', url: '' }),
    );
    expect(res.status).toBe(400);
    expect(await aggregatorCount()).toBe(0);
  });

  it('allows a moderator scoped to the requested community to register', async () => {
    mockAsModerator('denver');
    const res = await registerPOST(
      jsonRequest('http://localhost/api/admin/aggregators', 'POST', {
        name: 'Moderator Registered Aggregator',
        url: 'https://mod-agg.example',
        communitySlug: 'denver',
      }),
    );
    expect(res.status).toBe(201);
  });

  it('rejects a moderator NOT scoped to the requested community with 403 and creates no row', async () => {
    mockAsModerator('boulder');
    const res = await registerPOST(
      jsonRequest('http://localhost/api/admin/aggregators', 'POST', {
        name: 'Sneaky Aggregator',
        url: 'https://sneaky-agg.example',
        communitySlug: 'denver',
      }),
    );
    expect(res.status).toBe(403);
    expect(await aggregatorCount()).toBe(0);
  });
});

// ── GET /api/admin/aggregators (list, community-scoped, rollup) ────────────

describe('GET /api/admin/aggregators', () => {
  it('scopes the list by community and defaults to denver', async () => {
    await createAggregatorSource({ name: 'Denver Aggregator', url: 'https://denver-agg.example', communitySlug: 'denver' }, pool);
    await createAggregatorSource({ name: 'Boulder Aggregator', url: 'https://boulder-agg.example', communitySlug: 'boulder' }, pool);

    const denverRes = await listGET(new Request('http://localhost/api/admin/aggregators'));
    const denverData = await denverRes.json();
    expect(denverData.map((r: { name: string }) => r.name)).toEqual(['Denver Aggregator']);

    const boulderRes = await listGET(new Request('http://localhost/api/admin/aggregators?community=boulder'));
    const boulderData = await boulderRes.json();
    expect(boulderData.map((r: { name: string }) => r.name)).toEqual(['Boulder Aggregator']);
  });

  it('includes a pendingCandidateCount rollup that counts only PENDING candidates for that aggregator', async () => {
    const source = await createAggregatorSource(
      { name: 'Rollup Aggregator', url: 'https://rollup-agg.example', communitySlug: 'denver' },
      pool,
    );
    const other = await createAggregatorSource(
      { name: 'Other Aggregator', url: 'https://other-agg.example', communitySlug: 'denver' },
      pool,
    );

    const zeroRes = await listGET(new Request('http://localhost/api/admin/aggregators'));
    const zeroData = await zeroRes.json();
    expect(zeroData.find((r: { id: string }) => r.id === source.id).pendingCandidateCount).toBe(0);

    await enqueueCandidate(
      {
        name: 'Candidate One', websiteUrl: 'https://c1.example', city: null, communitySlug: 'denver',
        sourceKey: `aggregator:${source.id}`, sourceLabel: source.name, discoveryQuery: null, retrievedAt: new Date(),
        aggregatorSourceId: source.id,
      },
      pool,
    );
    const approvedRow = await enqueueCandidate(
      {
        name: 'Candidate Two (approved, excluded)', websiteUrl: 'https://c2.example', city: null, communitySlug: 'denver',
        sourceKey: `aggregator:${source.id}`, sourceLabel: source.name, discoveryQuery: null, retrievedAt: new Date(),
        aggregatorSourceId: source.id,
      },
      pool,
    );
    await pool.query(`UPDATE "ProviderCandidate" SET status = 'APPROVED' WHERE id = $1`, [approvedRow.id]);
    // A candidate belonging to a DIFFERENT aggregator must not bleed into this rollup.
    await enqueueCandidate(
      {
        name: 'Unrelated Candidate', websiteUrl: 'https://unrelated.example', city: null, communitySlug: 'denver',
        sourceKey: `aggregator:${other.id}`, sourceLabel: other.name, discoveryQuery: null, retrievedAt: new Date(),
        aggregatorSourceId: other.id,
      },
      pool,
    );

    const res = await listGET(new Request('http://localhost/api/admin/aggregators'));
    const data = await res.json();
    expect(data.find((r: { id: string }) => r.id === source.id).pendingCandidateCount).toBe(1);
    expect(data.find((r: { id: string }) => r.id === other.id).pendingCandidateCount).toBe(1);
  });
});

// ── GET /api/admin/aggregators/[id] (detail) ────────────────────────────────

describe('GET /api/admin/aggregators/[id]', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await detailGET(new Request('http://localhost/api/admin/aggregators/does-not-exist'), detailParams('does-not-exist'));
    expect(res.status).toBe(404);
  });

  it('returns the full row for a known id', async () => {
    const source = await createAggregatorSource(
      { name: 'Detail Aggregator', url: 'https://detail-agg.example', communitySlug: 'denver' },
      pool,
    );
    const res = await detailGET(new Request(`http://localhost/api/admin/aggregators/${source.id}`), detailParams(source.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(source.id);
    expect(data.name).toBe('Detail Aggregator');
  });

  it('an unauthenticated caller against a NONEXISTENT id gets the auth error, not a 404 (never leak existence pre-auth)', async () => {
    mockUnauthenticated();
    const res = await detailGET(new Request('http://localhost/api/admin/aggregators/does-not-exist'), detailParams('does-not-exist'));
    expect(res.status).toBe(401);
  });
});

// ── POST /api/admin/aggregators/[id]/tos-decision ───────────────────────────

describe('POST /api/admin/aggregators/[id]/tos-decision', () => {
  it('records an APPROVED decision, flips status to ACTIVE', async () => {
    const source = await createAggregatorSource(
      { name: 'ToS Aggregator', url: 'https://tos-agg.example', communitySlug: 'denver' },
      pool,
    );
    const res = await tosDecisionPOST(
      jsonRequest(`http://localhost/api/admin/aggregators/${source.id}/tos-decision`, 'POST', {
        decision: 'APPROVED',
        notes: 'Reviewed the ToS, automated access is permitted.',
      }),
      detailParams(source.id),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tosDecision).toBe('APPROVED');
    expect(data.status).toBe('ACTIVE');
    expect(data.tosReviewedBy).toBe('admin@campfit.test');
    expect(data.tosReviewedAt).toBeTruthy();
    expect(data.tosNotes).toBe('Reviewed the ToS, automated access is permitted.');
  });

  it('records a DECLINED decision, flips status to DECLINED', async () => {
    const source = await createAggregatorSource(
      { name: 'Declined ToS Aggregator', url: 'https://declined-tos-agg.example', communitySlug: 'denver' },
      pool,
    );
    const res = await tosDecisionPOST(
      jsonRequest(`http://localhost/api/admin/aggregators/${source.id}/tos-decision`, 'POST', { decision: 'DECLINED' }),
      detailParams(source.id),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tosDecision).toBe('DECLINED');
    expect(data.status).toBe('DECLINED');
  });

  it('rejects an invalid decision value with 400 and does not mutate the row', async () => {
    const source = await createAggregatorSource(
      { name: 'Invalid Decision Aggregator', url: 'https://invalid-decision-agg.example', communitySlug: 'denver' },
      pool,
    );
    const res = await tosDecisionPOST(
      jsonRequest(`http://localhost/api/admin/aggregators/${source.id}/tos-decision`, 'POST', { decision: 'MAYBE' }),
      detailParams(source.id),
    );
    expect(res.status).toBe(400);
    const { rows } = await pool.query(`SELECT "tosDecision" FROM "AggregatorSource" WHERE id = $1`, [source.id]);
    expect(rows[0].tosDecision).toBeNull();
  });

  it('returns 404 for an unknown id', async () => {
    const res = await tosDecisionPOST(
      jsonRequest('http://localhost/api/admin/aggregators/does-not-exist/tos-decision', 'POST', { decision: 'APPROVED' }),
      detailParams('does-not-exist'),
    );
    expect(res.status).toBe(404);
  });

  it('requires ADMIN auth, not moderator — a moderator gets 403 and does not mutate the row', async () => {
    const source = await createAggregatorSource(
      { name: 'Moderator-Blocked Aggregator', url: 'https://mod-blocked-agg.example', communitySlug: 'denver' },
      pool,
    );
    mockAsModerator('denver');

    const res = await tosDecisionPOST(
      jsonRequest(`http://localhost/api/admin/aggregators/${source.id}/tos-decision`, 'POST', { decision: 'APPROVED' }),
      detailParams(source.id),
    );
    expect(res.status).toBe(403);

    const { rows } = await pool.query(`SELECT "tosDecision" FROM "AggregatorSource" WHERE id = $1`, [source.id]);
    expect(rows[0].tosDecision).toBeNull();
  });
});
