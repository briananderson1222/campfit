/**
 * tests/integration/batch-accept-audit-repository.test.ts — integration
 * coverage for `lib/admin/batch-accept-audit-repository.ts` (campfit#51,
 * Wave 1 Task 1.2, R3/AC3), against the real throwaway Postgres so the
 * `"ReviewBatchAcceptAudit"` SCHEMA_FILES wiring itself is proven (a fresh
 * `resetTestDatabase()` provisions the table with zero manual DDL calls in
 * this file).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  getBatchAcceptAudit,
  recordBatchAcceptAudit,
  type BatchAcceptClaimRecord,
  type BatchAcceptExclusion,
} from '@/lib/admin/batch-accept-audit-repository';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

describe('batch-accept-audit-repository', () => {
  beforeAll(async () => {
    await assertTestDatabase();
  });

  afterEach(async () => {
    await getTestPool().query('TRUNCATE "ReviewBatchAcceptAudit"');
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('persists and reconstructs every field losslessly, including array-of-object round-trips', async () => {
    const pool = getTestPool();
    const claims: BatchAcceptClaimRecord[] = [
      {
        proposalId: 'proposal-1',
        campId: 'camp-1',
        field: 'city',
        oldValue: 'Old City',
        newValue: 'Austin',
        corroboratingProposalIds: ['proposal-2', 'proposal-3'],
        corroboratingSourceUrls: ['https://a.test/camp', 'https://b.test/camp'],
        sameSourceUrl: false,
        overallConfidenceAtAccept: 0.92,
      },
    ];
    const excluded: BatchAcceptExclusion[] = [
      { proposalId: 'proposal-4', field: 'description', reason: 'not_corroborated' },
      { proposalId: 'proposal-5', field: 'city', reason: 'out_of_scope', message: 'Outside admin community scope' },
    ];

    const id = await recordBatchAcceptAudit(pool, {
      performedBy: 'admin@campfit.test',
      criteria: 'exact-corroboration-v1',
      requestedCount: 3,
      claims,
      excluded,
    });

    const record = await getBatchAcceptAudit(id, pool);
    expect(record).not.toBeNull();
    expect(record!.performedBy).toBe('admin@campfit.test');
    expect(record!.criteria).toBe('exact-corroboration-v1');
    expect(record!.requestedCount).toBe(3);
    expect(record!.appliedCount).toBe(1);
    expect(record!.claims).toEqual(claims);
    expect(record!.excluded).toEqual(excluded);
    expect(typeof record!.performedAt).toBe('string');
    expect(Number.isNaN(Date.parse(record!.performedAt))).toBe(false);
  });

  it('represents a requestedCount/appliedCount mismatch (some excluded) and round-trips it', async () => {
    const pool = getTestPool();
    const id = await recordBatchAcceptAudit(pool, {
      performedBy: 'moderator@campfit.test',
      criteria: 'exact-corroboration-v1',
      requestedCount: 5,
      claims: [
        {
          proposalId: 'proposal-1',
          campId: 'camp-1',
          field: 'city',
          oldValue: null,
          newValue: 'Austin',
          corroboratingProposalIds: ['proposal-2'],
          corroboratingSourceUrls: ['https://a.test/camp'],
          sameSourceUrl: true,
          overallConfidenceAtAccept: 0.75,
        },
      ],
      excluded: [
        { proposalId: 'proposal-2', field: 'name', reason: 'not_corroborated' },
        { proposalId: 'proposal-3', field: 'name', reason: 'not_pending' },
        { proposalId: 'proposal-4', field: 'name', reason: 'out_of_scope' },
        { proposalId: 'proposal-5', field: 'name', reason: 'apply_error', message: 'boom' },
      ],
    });

    const record = await getBatchAcceptAudit(id, pool);
    expect(record!.requestedCount).toBe(5);
    expect(record!.appliedCount).toBe(1);
    expect(record!.excluded).toHaveLength(4);
  });

  it('returns null for an unknown id', async () => {
    const pool = getTestPool();
    const record = await getBatchAcceptAudit('00000000-0000-0000-0000-000000000000', pool);
    expect(record).toBeNull();
  });

  it('"ReviewBatchAcceptAudit" exists after a fresh resetTestDatabase() run with zero manual DDL in this file', async () => {
    const pool = getTestPool();
    const { rows } = await pool.query<{ marker: string | null }>(
      `SELECT to_regclass('public."ReviewBatchAcceptAudit"')::text AS marker`,
    );
    expect(rows[0]?.marker).toBeTruthy();
  });
});
