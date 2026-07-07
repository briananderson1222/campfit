/**
 * tests/integration/aggregator-discover-onboard-routes.test.ts — campfit#93
 * Wave 4, Task 4.1 acceptance suite for the discover/candidates/onboard
 * routes (AC1's route-level gate, AC3's curation dedupe metadata, AC4's
 * hardened onboarding).
 *
 * `requireAdminAccess` is mocked at the import boundary exactly like
 * `aggregator-routes.test.ts`. `runAggregatorDiscovery`
 * (`aggregator-extraction.ts`) and `resolveExtractionProvider`
 * (`resolve-extraction-provider.ts`) are ALSO mocked at their import
 * boundaries: `runAggregatorDiscovery`'s own crawlSource+extract() fixture
 * proof already lives in `aggregator-extraction.test.ts` (Wave 3, Task 3.1)
 * — this suite's job is proving the ROUTE's own gating/wiring (does it call
 * the function at all, with what args, and does it surface the function's
 * thrown errors as the right HTTP status), not re-proving the orchestration
 * itself. `AggregatorTosNotApprovedError`/`AggregatorSourceNotFoundError`
 * are re-exported from the REAL module (`importOriginal`) so `instanceof`
 * checks in the route still work against the mocked function's rejections.
 *
 * The candidates GET route and onboard POST route are exercised against the
 * REAL `onboardProviderCandidate`/`getCandidatesForAggregator` and the real
 * test DB — no mocking there, mirroring `candidate-onboarding.test.ts`'s own
 * unmocked discipline, now proven at the route layer.
 *
 * Coverage:
 *  - AC1 — discover route on an unapproved aggregator returns 409 and
 *    `runAggregatorDiscovery` is called ZERO times (the route-level half of
 *    the dual gate — proven by call-count, not just status code).
 *  - discover route on an approved aggregator calls `runAggregatorDiscovery`
 *    exactly once with `(id, {performedBy}, {provider}, pool)` and returns
 *    its summary as the 200 body.
 *  - discover route surfaces a THROWN `AggregatorTosNotApprovedError` from
 *    `runAggregatorDiscovery` itself (race-condition defense-in-depth) as
 *    the same 409.
 *  - discover route 404s for an unknown aggregator id.
 *  - AC3 — candidates route returns dedupe metadata
 *    (`possibleDuplicateOfProviderId`/`possibleDuplicateOfName`/
 *    `duplicateReason`) for a seeded near-duplicate candidate, and respects
 *    the `?status=` filter.
 *  - AC4 — onboard route with 2 candidate ids (one new domain, one matching
 *    an existing Provider) returns one `status:'created'` with a real new
 *    `providerId` and one `status:'existing'` with the pre-existing
 *    `providerId`; a real SELECT against "Provider" confirms exactly one
 *    new row was added. A third, invalid candidate id in the SAME batch
 *    comes back `status:'error'` without aborting the other two results.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const { requireAdminAccessMock, runAggregatorDiscoveryMock, resolveExtractionProviderMock } = vi.hoisted(() => ({
  requireAdminAccessMock: vi.fn(),
  runAggregatorDiscoveryMock: vi.fn(),
  resolveExtractionProviderMock: vi.fn(),
}));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

vi.mock('@/lib/ingestion/aggregator/aggregator-extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/aggregator/aggregator-extraction')>();
  return {
    ...actual,
    runAggregatorDiscovery: runAggregatorDiscoveryMock,
  };
});

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: resolveExtractionProviderMock,
}));

import { evaluateAdminAccess } from '@/lib/admin/access';
import { POST as discoverPOST } from '@/app/api/admin/aggregators/[id]/discover/route';
import { GET as candidatesGET } from '@/app/api/admin/aggregators/[id]/candidates/route';
import { POST as onboardPOST } from '@/app/api/admin/aggregators/[id]/candidates/onboard/route';
import { AggregatorTosNotApprovedError } from '@/lib/ingestion/aggregator/aggregator-extraction';
import {
  createAggregatorSource,
  ensureAggregatorSourceSchema,
  recordTosDecision,
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

  runAggregatorDiscoveryMock.mockReset();
  resolveExtractionProviderMock.mockReset();
  resolveExtractionProviderMock.mockReturnValue({
    provider: { extract: vi.fn() },
    ref: 'stub-ref',
    datumProvider: 'stub',
    model: 'stub-model',
    maxTokens: 1,
  });
});

afterEach(async () => {
  await pool.query(`TRUNCATE "ProviderCandidate", "Provider", "AggregatorSource" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

function postRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function registerAggregator(opts: { tosDecision?: 'APPROVED' | 'DECLINED' } = {}): Promise<string> {
  const source = await createAggregatorSource(
    { name: 'Discover Route Aggregator', url: 'https://discover-route-agg.example', communitySlug: 'denver' },
    pool,
  );
  if (opts.tosDecision) {
    await recordTosDecision(source.id, { decision: opts.tosDecision, reviewedBy: 'reviewer@campfit.test' }, pool);
  }
  return source.id;
}

async function providerCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "Provider"`);
  return Number(rows[0].count);
}

// ── AC1 — route-level ToS gate ──────────────────────────────────────────────

describe('AC1 — POST /api/admin/aggregators/[id]/discover route-level ToS gate', () => {
  it('returns 409 for an unapproved (REGISTERED) aggregator and calls runAggregatorDiscovery ZERO times', async () => {
    const id = await registerAggregator();

    const res = await discoverPOST(postRequest(`http://localhost/api/admin/aggregators/${id}/discover`), paramsFor(id));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/ToS decision required/i);
    expect(runAggregatorDiscoveryMock).toHaveBeenCalledTimes(0);
  });

  it('returns 409 for a DECLINED aggregator and calls runAggregatorDiscovery ZERO times', async () => {
    const id = await registerAggregator({ tosDecision: 'DECLINED' });

    const res = await discoverPOST(postRequest(`http://localhost/api/admin/aggregators/${id}/discover`), paramsFor(id));

    expect(res.status).toBe(409);
    expect(runAggregatorDiscoveryMock).toHaveBeenCalledTimes(0);
  });

  it('calls runAggregatorDiscovery exactly once and returns its summary for an APPROVED aggregator', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    const summary = {
      aggregatorSourceId: id,
      communitySlug: 'denver',
      discoveredPages: 2,
      discoveredCandidates: 3,
      enqueuedNew: 3,
      enqueuedNearDuplicate: 0,
      skippedDuplicate: 0,
      pageErrors: [],
      crawlWarnings: [],
      truncated: false,
      outcomes: [],
    };
    runAggregatorDiscoveryMock.mockResolvedValue(summary);

    const res = await discoverPOST(postRequest(`http://localhost/api/admin/aggregators/${id}/discover`), paramsFor(id));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual(summary);
    expect(runAggregatorDiscoveryMock).toHaveBeenCalledTimes(1);
    const [calledId, actor, deps] = runAggregatorDiscoveryMock.mock.calls[0];
    expect(calledId).toBe(id);
    expect(actor).toEqual({ performedBy: 'admin@campfit.test' });
    expect(deps.provider).toBeTruthy();
  });

  it('surfaces a thrown AggregatorTosNotApprovedError from runAggregatorDiscovery itself as a 409 (race defense-in-depth)', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    runAggregatorDiscoveryMock.mockRejectedValue(new AggregatorTosNotApprovedError(id));

    const res = await discoverPOST(postRequest(`http://localhost/api/admin/aggregators/${id}/discover`), paramsFor(id));

    expect(res.status).toBe(409);
    expect(runAggregatorDiscoveryMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown aggregator id and calls runAggregatorDiscovery ZERO times', async () => {
    const res = await discoverPOST(
      postRequest('http://localhost/api/admin/aggregators/does-not-exist/discover'),
      paramsFor('does-not-exist'),
    );
    expect(res.status).toBe(404);
    expect(runAggregatorDiscoveryMock).toHaveBeenCalledTimes(0);
  });

  it('rejects a moderator scoped to a different community with 403 and calls runAggregatorDiscovery ZERO times', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    mockAsModerator('boulder');

    const res = await discoverPOST(postRequest(`http://localhost/api/admin/aggregators/${id}/discover`), paramsFor(id));

    expect(res.status).toBe(403);
    expect(runAggregatorDiscoveryMock).toHaveBeenCalledTimes(0);
  });
});

// ── AC3 — candidates route dedupe metadata ──────────────────────────────────

describe('AC3 — GET /api/admin/aggregators/[id]/candidates', () => {
  it('returns dedupe metadata for a seeded near-duplicate candidate', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    await enqueueCandidate(
      {
        name: 'Near Duplicate Camp',
        websiteUrl: 'https://near-dup.example',
        city: null,
        communitySlug: 'denver',
        sourceKey: `aggregator:${id}`,
        sourceLabel: 'Discover Route Aggregator',
        discoveryQuery: 'https://discover-route-agg.example/camps',
        retrievedAt: new Date(),
        aggregatorSourceId: id,
        possibleDuplicateOfProviderId: 'existing-provider-id',
        possibleDuplicateOfName: 'Near Duplicate Camp Inc.',
        duplicateReason: 'name-similarity: 0.85',
      },
      pool,
    );

    const res = await candidatesGET(
      new Request(`http://localhost/api/admin/aggregators/${id}/candidates`),
      paramsFor(id),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].possibleDuplicateOfProviderId).toBe('existing-provider-id');
    expect(data[0].possibleDuplicateOfName).toBe('Near Duplicate Camp Inc.');
    expect(data[0].duplicateReason).toBe('name-similarity: 0.85');
  });

  it('respects the ?status= filter and defaults to PENDING', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    const pending = await enqueueCandidate(
      {
        name: 'Pending Candidate', websiteUrl: 'https://pending.example', city: null, communitySlug: 'denver',
        sourceKey: `aggregator:${id}`, sourceLabel: 'Discover Route Aggregator', discoveryQuery: null,
        retrievedAt: new Date(), aggregatorSourceId: id,
      },
      pool,
    );
    const approved = await enqueueCandidate(
      {
        name: 'Approved Candidate', websiteUrl: 'https://approved.example', city: null, communitySlug: 'denver',
        sourceKey: `aggregator:${id}`, sourceLabel: 'Discover Route Aggregator', discoveryQuery: null,
        retrievedAt: new Date(), aggregatorSourceId: id,
      },
      pool,
    );
    await pool.query(`UPDATE "ProviderCandidate" SET status = 'APPROVED' WHERE id = $1`, [approved.id]);

    const defaultRes = await candidatesGET(
      new Request(`http://localhost/api/admin/aggregators/${id}/candidates`),
      paramsFor(id),
    );
    const defaultData = await defaultRes.json();
    expect(defaultData.map((c: { id: string }) => c.id)).toEqual([pending.id]);

    const approvedRes = await candidatesGET(
      new Request(`http://localhost/api/admin/aggregators/${id}/candidates?status=APPROVED`),
      paramsFor(id),
    );
    const approvedData = await approvedRes.json();
    expect(approvedData.map((c: { id: string }) => c.id)).toEqual([approved.id]);

    const allRes = await candidatesGET(
      new Request(`http://localhost/api/admin/aggregators/${id}/candidates?status=ALL`),
      paramsFor(id),
    );
    const allData = await allRes.json();
    expect(allData).toHaveLength(2);
  });

  it('returns 404 for an unknown aggregator id', async () => {
    const res = await candidatesGET(
      new Request('http://localhost/api/admin/aggregators/does-not-exist/candidates'),
      paramsFor('does-not-exist'),
    );
    expect(res.status).toBe(404);
  });
});

// ── AC4 — onboard route ──────────────────────────────────────────────────────

describe('AC4 — POST /api/admin/aggregators/[id]/candidates/onboard', () => {
  it('onboards a mixed batch: one new-domain create, one existing-domain match, one invalid id error — without aborting the batch', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });

    const existingProviderId = randomUUID();
    await pool.query(
      `INSERT INTO "Provider" (id, name, slug, domain, "communitySlug") VALUES ($1, $2, $3, $4, $5)`,
      [existingProviderId, 'Already Onboarded Camp', `prov-${randomUUID()}`, 'already-onboarded.example', 'denver'],
    );

    const newCandidate = await enqueueCandidate(
      {
        name: 'Brand New Camp', websiteUrl: 'https://brand-new-onboard.example', city: null, communitySlug: 'denver',
        sourceKey: `aggregator:${id}`, sourceLabel: 'Discover Route Aggregator', discoveryQuery: null,
        retrievedAt: new Date(), aggregatorSourceId: id,
      },
      pool,
    );
    const existingMatchCandidate = await enqueueCandidate(
      {
        name: 'Already Onboarded Camp (aggregator copy)', websiteUrl: 'https://already-onboarded.example', city: null,
        communitySlug: 'denver', sourceKey: `aggregator:${id}`, sourceLabel: 'Discover Route Aggregator',
        discoveryQuery: null, retrievedAt: new Date(), aggregatorSourceId: id,
      },
      pool,
    );

    const res = await onboardPOST(
      postRequest(`http://localhost/api/admin/aggregators/${id}/candidates/onboard`, {
        candidateIds: [newCandidate.id, existingMatchCandidate.id, 'does-not-exist-candidate-id'],
      }),
      paramsFor(id),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(3);

    const createdResult = data.results.find((r: { candidateId: string }) => r.candidateId === newCandidate.id);
    expect(createdResult.status).toBe('created');
    expect(createdResult.providerCreated).toBe(true);
    expect(createdResult.providerId).toBeTruthy();
    expect(createdResult.providerId).not.toBe(existingProviderId);

    const existingResult = data.results.find((r: { candidateId: string }) => r.candidateId === existingMatchCandidate.id);
    expect(existingResult.status).toBe('existing');
    expect(existingResult.providerCreated).toBe(false);
    expect(existingResult.providerId).toBe(existingProviderId);

    const errorResult = data.results.find((r: { candidateId: string }) => r.candidateId === 'does-not-exist-candidate-id');
    expect(errorResult.status).toBe('error');
    expect(errorResult.error).toBeTruthy();

    // Real DB confirms: 1 pre-existing Provider + exactly 1 newly created one = 2 total.
    expect(await providerCount()).toBe(2);
  });

  it('rejects an empty candidateIds array with 400', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    const res = await onboardPOST(
      postRequest(`http://localhost/api/admin/aggregators/${id}/candidates/onboard`, { candidateIds: [] }),
      paramsFor(id),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a missing candidateIds field with 400', async () => {
    const id = await registerAggregator({ tosDecision: 'APPROVED' });
    const res = await onboardPOST(
      postRequest(`http://localhost/api/admin/aggregators/${id}/candidates/onboard`, {}),
      paramsFor(id),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown aggregator id', async () => {
    const res = await onboardPOST(
      postRequest('http://localhost/api/admin/aggregators/does-not-exist/candidates/onboard', { candidateIds: ['x'] }),
      paramsFor('does-not-exist'),
    );
    expect(res.status).toBe(404);
  });

  // H1 — authz boundary: a candidateId in the request body must belong to
  // the URL's aggregatorSourceId, regardless of what the requester is
  // authorized to act on. These are NOT fault-injection tests (no mocked
  // failure) — they exercise the real cross-aggregator guard added in
  // app/api/admin/aggregators/[id]/candidates/onboard/route.ts.
  describe('H1 — cross-aggregator candidateId rejection', () => {
    it('rejects a candidate belonging to a DIFFERENT aggregator with a per-candidate error and creates NO Provider row', async () => {
      const id = await registerAggregator({ tosDecision: 'APPROVED' });
      const otherId = await registerAggregator({ tosDecision: 'APPROVED' });

      const crossCandidate = await enqueueCandidate(
        {
          name: 'Cross Aggregator Camp', websiteUrl: 'https://cross-aggregator.example', city: null,
          communitySlug: 'denver', sourceKey: `aggregator:${otherId}`, sourceLabel: 'Other Aggregator',
          discoveryQuery: null, retrievedAt: new Date(), aggregatorSourceId: otherId,
        },
        pool,
      );

      const res = await onboardPOST(
        postRequest(`http://localhost/api/admin/aggregators/${id}/candidates/onboard`, {
          candidateIds: [crossCandidate.id],
        }),
        paramsFor(id),
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toHaveLength(1);
      expect(data.results[0].status).toBe('error');
      expect(data.results[0].error).toBeTruthy();
      expect(data.results[0].providerId).toBeUndefined();

      // No Provider row was created for the rejected cross-aggregator candidate.
      expect(await providerCount()).toBe(0);

      // The candidate row itself was never touched (still PENDING).
      const { rows } = await pool.query(`SELECT status FROM "ProviderCandidate" WHERE id = $1`, [crossCandidate.id]);
      expect(rows[0].status).toBe('PENDING');
    });

    it('handles a mixed batch: a same-aggregator candidate onboards while a cross-aggregator candidate in the SAME request is rejected', async () => {
      const id = await registerAggregator({ tosDecision: 'APPROVED' });
      const otherId = await registerAggregator({ tosDecision: 'APPROVED' });

      const sameAggCandidate = await enqueueCandidate(
        {
          name: 'Same Aggregator Camp', websiteUrl: 'https://same-aggregator.example', city: null,
          communitySlug: 'denver', sourceKey: `aggregator:${id}`, sourceLabel: 'Discover Route Aggregator',
          discoveryQuery: null, retrievedAt: new Date(), aggregatorSourceId: id,
        },
        pool,
      );
      const crossCandidate = await enqueueCandidate(
        {
          name: 'Cross Aggregator Camp Two', websiteUrl: 'https://cross-aggregator-two.example', city: null,
          communitySlug: 'denver', sourceKey: `aggregator:${otherId}`, sourceLabel: 'Other Aggregator',
          discoveryQuery: null, retrievedAt: new Date(), aggregatorSourceId: otherId,
        },
        pool,
      );

      const res = await onboardPOST(
        postRequest(`http://localhost/api/admin/aggregators/${id}/candidates/onboard`, {
          candidateIds: [sameAggCandidate.id, crossCandidate.id],
        }),
        paramsFor(id),
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toHaveLength(2);

      const sameResult = data.results.find((r: { candidateId: string }) => r.candidateId === sameAggCandidate.id);
      expect(sameResult.status).toBe('created');
      expect(sameResult.providerId).toBeTruthy();

      const crossResult = data.results.find((r: { candidateId: string }) => r.candidateId === crossCandidate.id);
      expect(crossResult.status).toBe('error');
      expect(crossResult.error).toBeTruthy();

      // Exactly one Provider was created — for the same-aggregator candidate only.
      expect(await providerCount()).toBe(1);
    });
  });
});
