import type { PoolClient } from 'pg';

import { getPool } from '@/lib/db';
import {
  assertServerReviewSessionFreshness,
  createServerReviewSessionRecord,
  hashReviewSessionSnapshot,
  StaleServerReviewSessionError,
} from '@kontourai/survey/review-workbench/server-review-session';
import {
  bindReviewQueue,
  defaultReviewSessionName,
  validateReviewQueueBinding,
  type ReviewQueueBinding,
} from '@kontourai/survey/review-workbench';
import { buildCampSurveyReviewQueueSession, type CampReviewQueueSession } from './survey-review-items';
import type { CampChangeProposal } from './types';

export interface SurveyReviewSessionRecord {
  readonly id: string;
  readonly proposalId: string;
  readonly sessionName: string;
  readonly snapshot: CampReviewQueueSession;
  readonly snapshotHash: string;
  /**
   * Queue-binding attestation (survey 2.4.0): taken ONCE, by
   * `getOrCreateSurveyReviewSessionForProposal`, when the round opens, and
   * persisted beside the queue in the same transaction. Never recomputed on a
   * later write — a digest a writer recomputes as it saves attests nothing.
   * `null` only for legacy rows opened before migration 021; those are
   * treated as stale (recreated on open, refused at read/apply), never
   * silently trusted.
   */
  readonly binding: ReviewQueueBinding | null;
  readonly proposalStatus: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
}

export class SurveyReviewSessionStaleError extends Error {
  constructor(message = 'Survey review session is stale for this proposal.') {
    super(message);
    this.name = 'SurveyReviewSessionStaleError';
  }
}

export async function getOrCreateSurveyReviewSessionForProposal(
  proposal: CampChangeProposal,
  opts: { readonly actorId: string },
): Promise<SurveyReviewSessionRecord> {
  const sessionName = defaultReviewSessionName;
  const existing = await findSurveyReviewSession({
    proposalId: proposal.id,
    sessionName,
  });

  if (existing && isSurveyReviewSessionFresh(existing, proposal)) {
    return existing;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`survey-session:${proposal.id}:${sessionName}`]);

    const lockedExisting = await findSurveyReviewSession({ proposalId: proposal.id, sessionName }, client);

    if (lockedExisting && isSurveyReviewSessionFresh(lockedExisting, proposal)) {
      await client.query('COMMIT');
      return lockedExisting;
    }

    if (lockedExisting) {
      await client.query(`DELETE FROM "SurveyReviewSession" WHERE id = $1`, [lockedExisting.id]);
    }

    const snapshot = buildCampSurveyReviewQueueSession(proposal, {
      actorId: opts.actorId,
      includeAppliedFields: true,
    });
    const snapshotHash = hashSurveyReviewSnapshot(snapshot);
    // Queue-binding attestation: the binding's authority is its ORIGIN — it
    // is taken here, exactly once, as the round opens, and lands in the same
    // transaction as the queue row itself. Every later read/apply validates
    // against this stored record; nothing ever re-binds a live round.
    const binding = bindReviewQueue(snapshot, { sessionName });
    const inserted = await client.query<SurveyReviewSessionRow>(
      `INSERT INTO "SurveyReviewSession"
         ("proposalId", "sessionName", snapshot, "snapshotHash", binding, "proposalStatus", "createdBy")
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
       RETURNING id, "proposalId", "sessionName", snapshot, "snapshotHash", binding, "proposalStatus",
                 "createdBy", "createdAt", "updatedAt", "appliedAt"`,
      [proposal.id, sessionName, JSON.stringify(snapshot), snapshotHash, JSON.stringify(binding), proposal.status, opts.actorId],
    );

    await client.query('COMMIT');
    return toSurveyReviewSessionRecord(inserted.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getSurveyReviewSessionForProposal(opts: {
  readonly proposalId: string;
  readonly reviewSessionId: string;
}): Promise<SurveyReviewSessionRecord | null> {
  const result = await getPool().query<SurveyReviewSessionRow>(
    `SELECT id, "proposalId", "sessionName", snapshot, "snapshotHash", binding, "proposalStatus",
            "createdBy", "createdAt", "updatedAt", "appliedAt"
     FROM "SurveyReviewSession"
     WHERE id = $1 AND "proposalId" = $2`,
    [opts.reviewSessionId, opts.proposalId],
  );
  const record = result.rows[0] ? toSurveyReviewSessionRecord(result.rows[0]) : null;
  // Refused at READ: a stored queue the open-time binding does not attest
  // (or an unbound legacy row) is never served to the events or apply paths.
  if (record) assertStoredQueueBinding(record);
  return record;
}

export function assertSurveyReviewSessionFreshForProposal(
  record: SurveyReviewSessionRecord,
  proposal: CampChangeProposal,
): void {
  if (!isSurveyReviewSessionFresh(record, proposal)) {
    throw new SurveyReviewSessionStaleError();
  }
}

export function hashSurveyReviewSnapshot(snapshot: CampReviewQueueSession): string {
  return hashReviewSessionSnapshot(snapshot);
}

function isSurveyReviewSessionFresh(record: SurveyReviewSessionRecord, proposal: CampChangeProposal): boolean {
  if (record.proposalId !== proposal.id) return false;
  if (record.proposalStatus !== proposal.status) return false;
  if (record.snapshotHash !== hashReviewSessionSnapshot(record.snapshot)) return false;
  // Queue-binding attestation: a session whose stored queue the open-time
  // binding does not attest — including a binding swapped in from a different
  // session, which the two hash comparisons above cannot see — is not fresh.
  // Legacy rows with no binding (pre-migration-021) are not fresh either, so
  // the next open recreates them with one.
  if (storedQueueBindingIssues(record).length > 0) return false;

  const current = buildCampSurveyReviewQueueSession(proposal, {
    actorId: record.snapshot.actorId,
    reviewedAt: record.snapshot.reviewedAt,
    includeAppliedFields: true,
  });

  try {
    assertServerReviewSessionFreshness(
      createServerReviewSessionRecord({
        sessionName: record.sessionName,
        snapshot: record.snapshot,
        updatedAt: record.updatedAt,
      }),
      current,
    );
    return true;
  } catch (error) {
    if (error instanceof StaleServerReviewSessionError) return false;
    throw error;
  }
}

/**
 * Issues preventing the stored binding from attesting the stored queue.
 * Validation always runs against the STORED binding — never one recomputed
 * from the bytes being checked, which would agree with anything.
 */
function storedQueueBindingIssues(record: SurveyReviewSessionRecord): string[] {
  if (!record.binding) {
    return ['Survey review session has no stored queue binding (opened before queue-binding adoption).'];
  }
  return validateReviewQueueBinding(record.binding, record.snapshot, { sessionName: record.sessionName })
    .map((issue) => issue.message);
}

/**
 * Refuses (as the same `SurveyReviewSessionStaleError` the staleness paths
 * already throw, so routes surface it identically) a session whose stored
 * queue is not attested by the binding taken when the round opened.
 */
function assertStoredQueueBinding(record: SurveyReviewSessionRecord): void {
  const issues = storedQueueBindingIssues(record);
  if (issues.length > 0) {
    throw new SurveyReviewSessionStaleError(
      `Survey review session queue is not attested by its stored binding: ${issues.join(' ')}`,
    );
  }
}

async function findSurveyReviewSession(opts: {
  readonly proposalId: string;
  readonly sessionName: string;
}, client?: PoolClient): Promise<SurveyReviewSessionRecord | null> {
  const queryable = client ?? getPool();
  const result = await queryable.query<SurveyReviewSessionRow>(
    `SELECT id, "proposalId", "sessionName", snapshot, "snapshotHash", binding, "proposalStatus",
            "createdBy", "createdAt", "updatedAt", "appliedAt"
     FROM "SurveyReviewSession"
     WHERE "proposalId" = $1 AND "sessionName" = $2`,
    [opts.proposalId, opts.sessionName],
  );
  return result.rows[0] ? toSurveyReviewSessionRecord(result.rows[0]) : null;
}

function toSurveyReviewSessionRecord(row: SurveyReviewSessionRow): SurveyReviewSessionRecord {
  return {
    id: row.id,
    proposalId: row.proposalId,
    sessionName: row.sessionName,
    snapshot: row.snapshot as CampReviewQueueSession,
    snapshotHash: row.snapshotHash,
    binding: (row.binding ?? null) as ReviewQueueBinding | null,
    proposalStatus: row.proposalStatus,
    createdBy: row.createdBy,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    appliedAt: row.appliedAt ? toIsoString(row.appliedAt) : null,
  };
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

interface SurveyReviewSessionRow {
  readonly id: string;
  readonly proposalId: string;
  readonly sessionName: string;
  readonly snapshot: unknown;
  readonly snapshotHash: string;
  readonly binding: unknown;
  readonly proposalStatus: string;
  readonly createdBy: string | null;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
  readonly appliedAt: string | Date | null;
}
