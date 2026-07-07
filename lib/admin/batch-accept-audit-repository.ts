/**
 * lib/admin/batch-accept-audit-repository.ts — persistence for
 * `"ReviewBatchAcceptAudit"` (campfit#51, Wave 1 Task 1.2, R3/AC3).
 *
 * One row per batch-accept action: who performed it, when, which claims were
 * applied (with the corroborating evidence and ranking context AT ACCEPT
 * TIME, server-recomputed — never a client-supplied value, see the plan's
 * "stop-short risks" section), and which selections were excluded and why.
 * The route (`app/api/admin/review/batch-accept/route.ts`, Wave 3) is the
 * sole caller of `recordBatchAcceptAudit` — `applyBatchAcceptedClaims`
 * (`review-apply.ts`) does not write this row itself, keeping that function
 * pool/transaction-only with no audit-table dependency of its own.
 */
import type { Pool } from 'pg';

import { getPool } from '@/lib/db';

export interface BatchAcceptClaimRecord {
  proposalId: string;
  campId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  corroboratingProposalIds: string[];
  corroboratingSourceUrls: string[];
  sameSourceUrl: boolean;
  overallConfidenceAtAccept: number;
}

export type BatchAcceptExclusionReason = 'not_pending' | 'not_corroborated' | 'out_of_scope' | 'apply_error';

export interface BatchAcceptExclusion {
  proposalId: string;
  field: string;
  reason: BatchAcceptExclusionReason;
  message?: string;
}

export interface BatchAcceptAuditRecord {
  id: string;
  performedBy: string;
  performedAt: string;
  criteria: string;
  requestedCount: number;
  appliedCount: number;
  claims: BatchAcceptClaimRecord[];
  excluded: BatchAcceptExclusion[];
}

export async function recordBatchAcceptAudit(
  pool: Pool,
  input: {
    performedBy: string;
    criteria: string;
    requestedCount: number;
    claims: BatchAcceptClaimRecord[];
    excluded: BatchAcceptExclusion[];
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "ReviewBatchAcceptAudit"
       ("performedBy", criteria, "requestedCount", "appliedCount", claims, excluded)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING id`,
    [
      input.performedBy,
      input.criteria,
      input.requestedCount,
      input.claims.length,
      JSON.stringify(input.claims),
      JSON.stringify(input.excluded),
    ],
  );
  return result.rows[0]!.id;
}

export async function getBatchAcceptAudit(id: string, pool: Pool = getPool()): Promise<BatchAcceptAuditRecord | null> {
  const result = await pool.query<{
    id: string;
    performedBy: string;
    performedAt: string | Date;
    criteria: string;
    requestedCount: number;
    appliedCount: number;
    claims: BatchAcceptClaimRecord[] | string;
    excluded: BatchAcceptExclusion[] | string;
  }>(
    `SELECT id, "performedBy", "performedAt", criteria, "requestedCount", "appliedCount", claims, excluded
     FROM "ReviewBatchAcceptAudit"
     WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    performedBy: row.performedBy,
    performedAt: row.performedAt instanceof Date ? row.performedAt.toISOString() : row.performedAt,
    criteria: row.criteria,
    requestedCount: row.requestedCount,
    appliedCount: row.appliedCount,
    // node-postgres parses a jsonb column into the already-decoded JS value
    // (array/object), not a string — but this repository normalizes to
    // `JSON.parse` defensively in case a future caller reads this column via
    // a text-mode client/driver where it would arrive as a raw string.
    claims: typeof row.claims === 'string' ? JSON.parse(row.claims) : row.claims,
    excluded: typeof row.excluded === 'string' ? JSON.parse(row.excluded) : row.excluded,
  };
}
