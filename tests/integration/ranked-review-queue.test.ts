/**
 * tests/integration/ranked-review-queue.test.ts — integration coverage for
 * `lib/admin/review-repository.ts`'s `getRankedReviewQueue`/
 * `getCampProposalHistoryBatch` (campfit#51, Wave 2 Task 2.1, R1/AC1),
 * against the real throwaway Postgres. Seeds >=4 Camps' `PENDING`
 * `CampChangeProposal`s with varying `overallConfidence` and varying
 * corroboration setups, then asserts lane membership + per-lane ordering
 * exactly matches `deriveFieldCorroboration`'s own derivation.
 *
 * `"CampChangeProposal"."crawlRunId"` has a real FK to `"CrawlRun"` — every
 * distinct crawlRunId used below is a real inserted `CrawlRun` row
 * (`insertCrawlRun`), not an arbitrary string literal.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { buildSnapshotSourceRef, createInMemorySnapshotStore, type Snapshot } from '@kontourai/traverse/fetch';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getRankedReviewQueue } from '@/lib/admin/review-repository';
import { deriveFieldCorroboration } from '@/lib/admin/claim-corroboration';
import type { ProposedChanges } from '@/lib/admin/types';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

async function insertCamp(pool: Pool, overrides: { communitySlug?: string; name?: string } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, "communitySlug")
     VALUES ($1, $2, 'SUMMER_DAY', 'SPORTS', $3)
     RETURNING id`,
    [`test-camp-${randomUUID()}`, overrides.name ?? 'Test Camp', overrides.communitySlug ?? 'denver'],
  );
  return result.rows[0]!.id;
}

async function insertCrawlRun(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "CrawlRun" (status) VALUES ('COMPLETED') RETURNING id`,
  );
  return result.rows[0]!.id;
}

async function insertProposal(pool: Pool, opts: {
  campId: string;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  crawlRunId: string;
  priority?: number;
  sourceUrl?: string;
  /**
   * `getRankedReviewQueue`'s base query only fetches `PENDING` proposals —
   * a "history-only" sibling row (created solely to be the corroborating
   * OTHER proposal `deriveFieldCorroboration` looks for) must NOT itself be
   * PENDING, or it would show up as its own second queue entry. Real
   * corroborating history is typically an older, already-resolved proposal
   * (APPROVED/SKIPPED) for the same field/value; PENDING is only used for
   * the row(s) actually under test.
   */
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
  snapshotRef?: string | null;
  snapshotBodyHash?: string | null;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "CampChangeProposal"
       ("campId", "crawlRunId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status, priority, "snapshotRef", "snapshotBodyHash")
     VALUES ($1, $2, $3, $4::jsonb, $5, 'test-extraction-model', $6, $7, $8, $9)
     RETURNING id`,
    [
      opts.campId,
      opts.crawlRunId,
      opts.sourceUrl ?? 'https://example.test/camp',
      JSON.stringify(opts.proposedChanges),
      opts.overallConfidence,
      opts.status ?? 'PENDING',
      opts.priority ?? 0,
      opts.snapshotRef ?? null,
      opts.snapshotBodyHash ?? null,
    ],
  );
  return result.rows[0]!.id;
}

function diff(newValue: unknown, sourceUrl = 'https://example.test/camp'): ProposedChanges {
  return { city: { old: 'Previous city', new: newValue, confidence: 0.8, sourceUrl } };
}

describe('getRankedReviewQueue', () => {
  beforeAll(async () => {
    await assertTestDatabase();
  });

  afterEach(async () => {
    const pool = getTestPool();
    await pool.query('TRUNCATE "CampChangeProposal", "Camp", "CrawlRun" CASCADE');
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('surfaces true for exact stored low-risk evidence and false for missing provenance', async () => {
    const pool = getTestPool();
    const store = createInMemorySnapshotStore();
    const sourceUrl = 'https://shadow.example.test/camp';
    const body = '<main>New description</main>';
    const snapshot: Snapshot = {
      sourceId: 'shadow-source', url: sourceUrl,
      fetchedAt: '2026-07-13T12:00:00.000Z', status: 200, contentType: 'html', body,
      bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    };
    await store.put(snapshot);
    const passingId = await insertProposal(pool, {
      campId: await insertCamp(pool),
      crawlRunId: await insertCrawlRun(pool),
      sourceUrl,
      proposedChanges: { description: { old: '', new: 'New description', confidence: 0.99, excerpt: 'New description' } },
      overallConfidence: 0.99,
      snapshotRef: buildSnapshotSourceRef(snapshot),
      snapshotBodyHash: snapshot.bodyHash,
    });
    const failingId = await insertProposal(pool, {
      campId: await insertCamp(pool),
      crawlRunId: await insertCrawlRun(pool),
      proposedChanges: { description: { old: '', new: 'Missing snapshot', confidence: 0.99, excerpt: 'Missing snapshot' } },
      overallConfidence: 0.99,
    });

    const queue = await getRankedReviewQueue({ snapshotStore: store });
    const proposals = [...queue.batchReady, ...queue.needsReview];
    expect(proposals.find((row) => row.id === passingId)).toHaveProperty('shadowAutoAccept', true);
    expect(proposals.find((row) => row.id === failingId)).toHaveProperty('shadowAutoAccept', false);
  });

  it('(a)-(c) lane membership matches deriveFieldCorroboration, batchReady DESC, needsReview ASC', async () => {
    const pool = getTestPool();
    const runA1 = await insertCrawlRun(pool);
    const runA2 = await insertCrawlRun(pool);
    const runB1 = await insertCrawlRun(pool);
    const runB2 = await insertCrawlRun(pool);
    const runC1 = await insertCrawlRun(pool);
    const runD1 = await insertCrawlRun(pool);
    const runE1 = await insertCrawlRun(pool);

    // Camp A: high confidence, corroborated (different crawlRunId, same value) -> batchReady
    const campA = await insertCamp(pool, { name: 'Camp A' });
    const proposalA = await insertProposal(pool, { campId: campA, proposedChanges: diff('Austin'), overallConfidence: 0.95, crawlRunId: runA1 });
    await insertProposal(pool, { campId: campA, proposedChanges: diff('Austin'), overallConfidence: 0.5, crawlRunId: runA2, status: 'APPROVED' });

    // Camp B: mid confidence, corroborated -> batchReady
    const campB = await insertCamp(pool, { name: 'Camp B' });
    const proposalB = await insertProposal(pool, { campId: campB, proposedChanges: diff('Denver'), overallConfidence: 0.7, crawlRunId: runB1 });
    await insertProposal(pool, { campId: campB, proposedChanges: diff('Denver'), overallConfidence: 0.4, crawlRunId: runB2, status: 'APPROVED' });

    // Camp C: only one proposal ever — zero history rows besides itself; not corroborated.
    const campC = await insertCamp(pool, { name: 'Camp C' });
    const proposalC = await insertProposal(pool, { campId: campC, proposedChanges: diff('Boulder'), overallConfidence: 0.85, crawlRunId: runC1 });

    // Camp D: low confidence, not corroborated -> needsReview
    const campD = await insertCamp(pool, { name: 'Camp D' });
    const proposalD = await insertProposal(pool, { campId: campD, proposedChanges: diff('Golden'), overallConfidence: 0.2, crawlRunId: runD1 });

    // Camp E: mid-low confidence, not corroborated -> needsReview
    const campE = await insertCamp(pool, { name: 'Camp E' });
    const proposalE = await insertProposal(pool, { campId: campE, proposedChanges: diff('Golden'), overallConfidence: 0.45, crawlRunId: runE1 });

    const { batchReady, needsReview, total } = await getRankedReviewQueue({});

    expect(total).toBe(5);

    const batchReadyIds = [...batchReady.map((p) => p.id)].sort();
    const needsReviewIds = [...needsReview.map((p) => p.id)].sort();

    expect(batchReadyIds).toEqual([proposalA, proposalB].sort());
    expect(needsReviewIds).toEqual([proposalC, proposalD, proposalE].sort());

    // (b) batchReady sorted overallConfidence DESC (A: 0.95 before B: 0.7)
    expect(batchReady.map((p) => p.id)).toEqual([proposalA, proposalB]);

    // (c) needsReview sorted overallConfidence ASC (D: 0.2, E: 0.45, C: 0.85)
    expect(needsReview.map((p) => p.id)).toEqual([proposalD, proposalE, proposalC]);

    // Lane membership matches deriveFieldCorroboration's own output exactly.
    const proposalARow = batchReady.find((p) => p.id === proposalA)!;
    expect(proposalARow.fieldCorroboration.city.exact).toBe(true);
    expect(proposalARow.batchEligibleFieldCount).toBe(1);

    const proposalCRow = needsReview.find((p) => p.id === proposalC)!;
    expect(proposalCRow.fieldCorroboration.city.exact).toBe(false);
    expect(proposalCRow.batchEligibleFieldCount).toBe(0);

    // Cross-check against calling the pure function directly for campA.
    const direct = deriveFieldCorroboration({
      targetProposalId: proposalA,
      targetCrawlRunId: runA1,
      field: 'city',
      history: [
        { id: proposalA, proposedChanges: diff('Austin'), sourceUrl: 'https://example.test/camp', crawlRunId: runA1, createdAt: new Date().toISOString() },
        { id: 'sibling', proposedChanges: diff('Austin'), sourceUrl: 'https://example.test/camp', crawlRunId: runA2, createdAt: new Date().toISOString() },
      ],
    });
    expect(direct.exact).toBe(proposalARow.fieldCorroboration.city.exact);
  });

  it('routes an all-populate fresh discovery to needsReview even when every field is exact-corroborated', async () => {
    const pool = getTestPool();
    const targetRun = await insertCrawlRun(pool);
    const historyRun = await insertCrawlRun(pool);
    const camp = await insertCamp(pool, { name: 'Fresh discovery placeholder' });
    const proposedChanges: ProposedChanges = {
      name: { old: null, new: 'Pine Ridge Camp', confidence: 0.96, mode: 'populate' },
      city: { old: null, new: 'Denver', confidence: 0.92 },
    };
    const proposalId = await insertProposal(pool, { campId: camp, proposedChanges, overallConfidence: 0.94, crawlRunId: targetRun });
    await insertProposal(pool, { campId: camp, proposedChanges, overallConfidence: 0.8, crawlRunId: historyRun, status: 'APPROVED' });

    const { batchReady, needsReview } = await getRankedReviewQueue({});
    expect(batchReady.some((proposal) => proposal.id === proposalId)).toBe(false);
    const row = needsReview.find((proposal) => proposal.id === proposalId);
    expect(row).toBeDefined();
    expect(row?.fieldCorroboration.name.exact).toBe(true);
    expect(row?.fieldCorroboration.city.exact).toBe(true);
    expect(row?.batchEligibleFieldCount).toBe(0);
  });

  it('keeps a mixed proposal batchReady while counting only its corroborated diff field', async () => {
    const pool = getTestPool();
    const targetRun = await insertCrawlRun(pool);
    const historyRun = await insertCrawlRun(pool);
    const camp = await insertCamp(pool, { name: 'Mixed proposal camp' });
    const proposedChanges: ProposedChanges = {
      city: { old: 'Boulder', new: 'Denver', confidence: 0.9 },
      description: { old: null, new: 'A newly found description', confidence: 0.85, mode: 'populate' },
    };
    const proposalId = await insertProposal(pool, { campId: camp, proposedChanges, overallConfidence: 0.9, crawlRunId: targetRun });
    await insertProposal(pool, { campId: camp, proposedChanges, overallConfidence: 0.7, crawlRunId: historyRun, status: 'APPROVED' });

    const { batchReady, needsReview } = await getRankedReviewQueue({});
    expect(needsReview.some((proposal) => proposal.id === proposalId)).toBe(false);
    const row = batchReady.find((proposal) => proposal.id === proposalId);
    expect(row).toBeDefined();
    expect(row?.fieldCorroboration.city.exact).toBe(true);
    expect(row?.fieldCorroboration.description.exact).toBe(true);
    expect(row?.batchEligibleFieldCount).toBe(1);
  });

  it('a corroborating row sharing the target\'s own crawlRunId does NOT count', async () => {
    const pool = getTestPool();
    const sharedRun = await insertCrawlRun(pool);

    const camp = await insertCamp(pool, { name: 'Same-run retries only' });
    const proposal = await insertProposal(pool, { campId: camp, proposedChanges: diff('Boulder'), overallConfidence: 0.6, crawlRunId: sharedRun });
    // A second proposal from the SAME crawlRunId proposing the same value — must not corroborate.
    await insertProposal(pool, { campId: camp, proposedChanges: diff('Boulder'), overallConfidence: 0.55, crawlRunId: sharedRun, status: 'APPROVED' });

    const { batchReady, needsReview } = await getRankedReviewQueue({});
    expect(batchReady.find((p) => p.id === proposal)).toBeUndefined();
    const row = needsReview.find((p) => p.id === proposal);
    expect(row).toBeDefined();
    expect(row!.fieldCorroboration.city.exact).toBe(false);
  });

  it('(d) a priority: -1 (partially-reviewed) row still sinks within its lane regardless of confidence', async () => {
    const pool = getTestPool();
    const run1 = await insertCrawlRun(pool);
    const run1b = await insertCrawlRun(pool);
    const run2 = await insertCrawlRun(pool);
    const run2b = await insertCrawlRun(pool);

    const camp1 = await insertCamp(pool, { name: 'High confidence, fresh' });
    const proposal1 = await insertProposal(pool, { campId: camp1, proposedChanges: diff('X'), overallConfidence: 0.9, crawlRunId: run1 });
    await insertProposal(pool, { campId: camp1, proposedChanges: diff('X'), overallConfidence: 0.1, crawlRunId: run1b, status: 'APPROVED' });

    const camp2 = await insertCamp(pool, { name: 'Low confidence, but partially reviewed (sunk)' });
    const proposal2 = await insertProposal(pool, { campId: camp2, proposedChanges: diff('Y'), overallConfidence: 0.99, crawlRunId: run2, priority: -1 });
    await insertProposal(pool, { campId: camp2, proposedChanges: diff('Y'), overallConfidence: 0.01, crawlRunId: run2b, status: 'APPROVED' });

    const { batchReady } = await getRankedReviewQueue({});
    const ids = batchReady.map((p) => p.id);
    // proposal2 has priority -1 (sinks), so it must be AFTER proposal1 (priority 0)
    // despite proposal2's overallConfidence (0.99) being higher.
    expect(ids.indexOf(proposal1)).toBeLessThan(ids.indexOf(proposal2));
  });

  it('(f) REVIEW H2: with an injected small safetyCap, needsReview retains the LOWEST-confidence rows and total stays honest (none silently lost)', async () => {
    const pool = getTestPool();
    // 8 distinct, uncorroborated (single-proposal-per-camp) proposals with
    // confidences spanning the full range — all land in needsReview.
    // safetyCap: 5 forces both the old bug (confidence-DESC-only fetch would
    // return the *highest* 5, silently dropping the lowest 3 that
    // needsReview most needs) and this fix's guarantee (the lowest 5 must
    // survive into needsReview; the honest total must still say 8).
    const confidences = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const proposalIdByConfidence = new Map<number, string>();
    for (const confidence of confidences) {
      const run = await insertCrawlRun(pool);
      const camp = await insertCamp(pool, { name: `Camp ${confidence}` });
      const proposalId = await insertProposal(pool, {
        campId: camp,
        proposedChanges: diff(`value-${confidence}`),
        overallConfidence: confidence,
        crawlRunId: run,
      });
      proposalIdByConfidence.set(confidence, proposalId);
    }

    const { batchReady, needsReview, total, rankedCount } = await getRankedReviewQueue({ safetyCap: 5 });

    expect(batchReady).toEqual([]);
    expect(total).toBe(8); // honest — not truncated to the cap
    expect(rankedCount).toBe(5); // working set IS bounded by the cap

    // The lane must contain the 5 LOWEST-confidence rows (0.1..0.5), sorted
    // ascending — never the 5 highest, and never missing the true lowest.
    const expectedIds = [0.1, 0.2, 0.3, 0.4, 0.5].map((c) => proposalIdByConfidence.get(c)!);
    expect(needsReview.map((p) => p.id)).toEqual(expectedIds);
    expect(needsReview.map((p) => p.overallConfidence)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it('(e) community scoping excludes out-of-scope camps\' proposals from both lanes', async () => {
    const pool = getTestPool();
    const run1 = await insertCrawlRun(pool);
    const run1b = await insertCrawlRun(pool);
    const run2 = await insertCrawlRun(pool);

    const inScopeCamp = await insertCamp(pool, { name: 'In scope', communitySlug: 'denver' });
    const inScopeCorroborated = await insertProposal(pool, { campId: inScopeCamp, proposedChanges: diff('X'), overallConfidence: 0.9, crawlRunId: run1 });
    await insertProposal(pool, { campId: inScopeCamp, proposedChanges: diff('X'), overallConfidence: 0.2, crawlRunId: run1b, status: 'APPROVED' });

    const outOfScopeCamp = await insertCamp(pool, { name: 'Out of scope', communitySlug: 'boulder' });
    const outOfScopeUncorroborated = await insertProposal(pool, { campId: outOfScopeCamp, proposedChanges: diff('Y'), overallConfidence: 0.5, crawlRunId: run2 });

    const { batchReady, needsReview, total } = await getRankedReviewQueue({ communitySlugs: ['denver'] });

    expect(total).toBe(1);
    expect(batchReady.map((p) => p.id)).toEqual([inScopeCorroborated]);
    expect(needsReview).toEqual([]);
    expect([...batchReady, ...needsReview].some((p) => p.id === outOfScopeUncorroborated)).toBe(false);
  });
});
