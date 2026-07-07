/**
 * tests/integration/batch-accept-apply.test.ts — integration suite for
 * `lib/admin/review-apply.ts`'s `applyBatchAcceptedClaims` (campfit#51, Wave
 * 2 Task 2.2, R2/R3/R4/AC2/AC3), against the real throwaway Postgres.
 * Mirrors `review-apply.test.ts`'s seeding/truncation discipline exactly —
 * `applyBatchAcceptedClaims` reuses the SAME transactional/evidence primitives.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getPool as getProductionPool } from '@/lib/db';
import { applyBatchAcceptedClaims } from '@/lib/admin/review-apply';
import { getCampProposalHistoryBatch } from '@/lib/admin/review-repository';
import { campCanonicalClaimId } from '@/lib/admin/trust-projection';
import type { FieldDiff, ProposedChanges } from '@/lib/admin/types';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const ACTOR = 'admin@campfit.test';

function fieldDiff(old: unknown, next: unknown, overrides: Partial<FieldDiff> = {}): FieldDiff {
  return {
    old,
    new: next,
    confidence: 0.9,
    excerpt: 'Verbatim excerpt from the source page.',
    sourceUrl: 'https://example.test/camp',
    mode: 'update',
    ...overrides,
  };
}

async function insertCamp(pool: Pool, overrides: { description?: string; city?: string } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city)
     VALUES ($1, $2, 'SUMMER_DAY', 'SPORTS', $3, $4)
     RETURNING id`,
    [`test-camp-${randomUUID()}`, 'Test Camp', overrides.description ?? '', overrides.city ?? ''],
  );
  return result.rows[0]!.id;
}

async function insertCrawlRun(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`INSERT INTO "CrawlRun" (status) VALUES ('COMPLETED') RETURNING id`);
  return result.rows[0]!.id;
}

async function insertProposal(pool: Pool, opts: {
  campId: string;
  proposedChanges: ProposedChanges;
  crawlRunId: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
  overallConfidence?: number;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "crawlRunId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status)
     VALUES ($1, $2, 'https://example.test/camp', $3::jsonb, $4, 'test-extraction-model', $5)
     RETURNING id`,
    [opts.campId, opts.crawlRunId, JSON.stringify(opts.proposedChanges), opts.overallConfidence ?? 0.9, opts.status ?? 'PENDING'],
  );
  return result.rows[0]!.id;
}

async function queryCamp(pool: Pool, campId: string) {
  const result = await pool.query(
    `SELECT description, city, "dataConfidence", "lastVerifiedAt" FROM "Camp" WHERE id = $1`,
    [campId],
  );
  return result.rows[0] as { description: string; city: string; dataConfidence: string; lastVerifiedAt: string | null } | undefined;
}

async function queryProposal(pool: Pool, proposalId: string) {
  const result = await pool.query(
    `SELECT status, "appliedFields", priority FROM "CampChangeProposal" WHERE id = $1`,
    [proposalId],
  );
  return result.rows[0] as { status: string; appliedFields: string[] | null; priority: number } | undefined;
}

/** Seeds a corroborating (different-crawlRunId, same-value) sibling proposal for `field`/`value` on `campId`, already resolved (not PENDING) so it never shows up as its own queue entry — matches ranked-review-queue.test.ts's convention. */
async function seedCorroboratingHistory(pool: Pool, campId: string, field: string, value: unknown): Promise<void> {
  const runId = await insertCrawlRun(pool);
  await insertProposal(pool, {
    campId,
    proposedChanges: { [field]: fieldDiff(null, value) },
    crawlRunId: runId,
    status: 'APPROVED',
  });
}

async function historyFor(pool: Pool, campId: string) {
  const map = await getCampProposalHistoryBatch(pool, [campId]);
  return map;
}

describe('applyBatchAcceptedClaims', () => {
  beforeAll(async () => {
    await assertTestDatabase();
  });

  afterEach(async () => {
    const pool = getTestPool();
    await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
    await pool.query(`TRUNCATE "CrawlMetric";`);
    await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
  });

  afterAll(async () => {
    await closeTestPool();
    await getProductionPool().end();
  });

  it('(a) a corroborated selection is applied: Camp updated, Evidence/Event recorded, dataConfidence/lastVerifiedAt refreshed', async () => {
    const pool = getTestPool();
    const campId = await insertCamp(pool, { city: '' });
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: { city: fieldDiff('', 'Austin') },
      crawlRunId: targetRun,
      overallConfidence: 0.9,
    });
    await seedCorroboratingHistory(pool, campId, 'city', 'Austin');

    const historyByCamp = await historyFor(pool, campId);
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [{ proposalId, field: 'city' }],
      actor: ACTOR,
      historyByCamp,
    });

    expect(result.outcomes).toEqual([{ proposalId, field: 'city', status: 'applied' }]);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      proposalId,
      campId,
      field: 'city',
      oldValue: '',
      newValue: 'Austin',
      sameSourceUrl: true,
    });
    expect(result.claims[0]!.corroboratingProposalIds).toHaveLength(1);

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.city).toBe('Austin');
    expect(campRow?.lastVerifiedAt).not.toBeNull();

    const claimId = campCanonicalClaimId(campId, 'city');
    const claimRows = await pool.query(`SELECT id FROM "SurfaceClaimDefinition" WHERE id = $1`, [claimId]);
    expect(claimRows.rows).toHaveLength(1);
    const eventRows = await pool.query<{ status: string }>(`SELECT status FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`, [claimId]);
    expect(eventRows.rows).toEqual([{ status: 'verified' }]);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe('APPROVED');
  });

  it('(b) a selection with NO corroborating history is excluded, Camp unchanged, no Evidence written', async () => {
    const pool = getTestPool();
    const campId = await insertCamp(pool, { city: '' });
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: { city: fieldDiff('', 'Austin') },
      crawlRunId: targetRun,
    });
    // No corroborating sibling seeded.

    const historyByCamp = await historyFor(pool, campId);
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [{ proposalId, field: 'city' }],
      actor: ACTOR,
      historyByCamp,
    });

    expect(result.outcomes).toEqual([{
      proposalId,
      field: 'city',
      status: 'excluded_not_corroborated',
      message: 'No exact-corroborating observation from a different crawl run was found.',
    }]);
    expect(result.claims).toEqual([]);

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.city).toBe('');

    const claimId = campCanonicalClaimId(campId, 'city');
    const claimRows = await pool.query(`SELECT id FROM "SurfaceClaimDefinition" WHERE id = $1`, [claimId]);
    expect(claimRows.rows).toHaveLength(0);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe('PENDING');
  });

  it('(c) a Proposal with 3 fields, only 2 corroborated: stays PENDING via partialApprove with exactly those 2 in appliedFields', async () => {
    const pool = getTestPool();
    const campId = await insertCamp(pool, { city: '', description: '' });
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: {
        city: fieldDiff('', 'Austin'),
        description: fieldDiff('', 'A great camp'),
        contactPhone: fieldDiff(null, '303-555-0100'),
      },
      crawlRunId: targetRun,
    });
    await seedCorroboratingHistory(pool, campId, 'city', 'Austin');
    await seedCorroboratingHistory(pool, campId, 'description', 'A great camp');
    // contactPhone has no corroborating history.

    const historyByCamp = await historyFor(pool, campId);
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [
        { proposalId, field: 'city' },
        { proposalId, field: 'description' },
        { proposalId, field: 'contactPhone' },
      ],
      actor: ACTOR,
      historyByCamp,
    });

    const statusByField = Object.fromEntries(result.outcomes.map((o) => [o.field, o.status]));
    expect(statusByField.city).toBe('applied');
    expect(statusByField.description).toBe('applied');
    expect(statusByField.contactPhone).toBe('excluded_not_corroborated');
    expect(result.claims.map((c) => c.field).sort()).toEqual(['city', 'description']);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe('PENDING');
    expect(proposalRow?.priority).toBe(-1);
    expect(proposalRow?.appliedFields?.slice().sort()).toEqual(['city', 'description']);
  });

  it('(d) a Proposal where ALL unapplied fields are corroborated and selected: transitions to APPROVED', async () => {
    const pool = getTestPool();
    const campId = await insertCamp(pool, { city: '', description: '' });
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: {
        city: fieldDiff('', 'Austin'),
        description: fieldDiff('', 'A great camp'),
      },
      crawlRunId: targetRun,
    });
    await seedCorroboratingHistory(pool, campId, 'city', 'Austin');
    await seedCorroboratingHistory(pool, campId, 'description', 'A great camp');

    const historyByCamp = await historyFor(pool, campId);
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [
        { proposalId, field: 'city' },
        { proposalId, field: 'description' },
      ],
      actor: ACTOR,
      historyByCamp,
    });

    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe('APPROVED');
  });

  it('(e) calling twice with the same selection is idempotent (proposal stays PENDING via partial accept): no duplicate Camp writes/Evidence rows', async () => {
    const pool = getTestPool();
    // Two fields on the proposal, only one ("city") selected/corroborated —
    // the proposal stays PENDING (partial accept) after the first call, so
    // a second call with the SAME selection re-enters lockAndCheckProposal's
    // idempotency-under-lock path (mirrors applyProposalReview's own
    // idempotent-retry coverage), rather than hitting the
    // no-longer-PENDING/excluded_not_pending path a fully-applied
    // single-field proposal would.
    const campId = await insertCamp(pool, { city: '', description: '' });
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: { city: fieldDiff('', 'Austin'), description: fieldDiff('', 'Not yet corroborated') },
      crawlRunId: targetRun,
    });
    await seedCorroboratingHistory(pool, campId, 'city', 'Austin');
    // "description" has no corroborating history — never selected below either way.

    const historyByCamp = await historyFor(pool, campId);
    const selections = [{ proposalId, field: 'city' }];

    const first = await applyBatchAcceptedClaims(pool, { selections, actor: ACTOR, historyByCamp });
    expect(first.claims).toHaveLength(1);
    expect((await queryProposal(pool, proposalId))?.status).toBe('PENDING');

    const second = await applyBatchAcceptedClaims(pool, { selections, actor: ACTOR, historyByCamp });
    // Second call sees "city" already applied under the lock — reported as
    // 'applied' (the desired end state already holds), but with no new
    // claim/evidence recorded for it (no duplicate write).
    expect(second.outcomes).toEqual([{ proposalId, field: 'city', status: 'applied' }]);
    expect(second.claims).toEqual([]);

    const claimId = campCanonicalClaimId(campId, 'city');
    const eventRows = await pool.query(`SELECT id FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`, [claimId]);
    expect(eventRows.rows).toHaveLength(1);

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.city).toBe('Austin');
  });

  it('excluded_not_pending when the proposal is no longer PENDING', async () => {
    const pool = getTestPool();
    const campId = await insertCamp(pool, { city: '' });
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: { city: fieldDiff('', 'Austin') },
      crawlRunId: targetRun,
      status: 'APPROVED',
    });

    const historyByCamp = await historyFor(pool, campId);
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [{ proposalId, field: 'city' }],
      actor: ACTOR,
      historyByCamp,
    });

    expect(result.outcomes).toEqual([{ proposalId, field: 'city', status: 'excluded_not_pending', message: 'Proposal is no longer PENDING.' }]);
    expect(result.claims).toEqual([]);
  });

  it('excluded_not_pending for an unknown proposalId', async () => {
    const pool = getTestPool();
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [{ proposalId: randomUUID(), field: 'city' }],
      actor: ACTOR,
      historyByCamp: new Map(),
    });
    expect(result.outcomes[0]!.status).toBe('excluded_not_pending');
    expect(result.outcomes[0]!.message).toBe('Proposal was not found.');
  });

  it('excluded_not_pending for a relation field (out of scope for batch corroboration)', async () => {
    const pool = getTestPool();
    const campId = await insertCamp(pool);
    const targetRun = await insertCrawlRun(pool);
    const proposalId = await insertProposal(pool, {
      campId,
      proposedChanges: {
        ageGroups: { old: [], new: [{ label: 'Ages 5-8', minAge: 5, maxAge: 8, minGrade: null, maxGrade: null }], confidence: 0.9 },
      },
      crawlRunId: targetRun,
    });

    const historyByCamp = await historyFor(pool, campId);
    const result = await applyBatchAcceptedClaims(pool, {
      selections: [{ proposalId, field: 'ageGroups' }],
      actor: ACTOR,
      historyByCamp,
    });

    expect(result.outcomes[0]!.status).toBe('excluded_not_pending');
    expect(result.claims).toEqual([]);
  });
});
