import type { PoolClient } from 'pg';

import { getPool } from '@/lib/db';
import {
  assertServerReviewSessionFreshness,
  createServerReviewSessionRecord,
  hashReviewSessionSnapshot,
  StaleServerReviewSessionError,
} from '@kontourai/survey/review-workbench/server-review-session';
import { defaultReviewSessionName } from '@kontourai/survey/review-workbench';
import { buildCampSurveyReviewQueueSession, type CampReviewQueueSession } from './survey-review-items';
import type { CampChangeProposal } from './types';

export interface SurveyReviewSessionRecord {
  readonly id: string;
  readonly proposalId: string;
  readonly sessionName: string;
  readonly snapshot: CampReviewQueueSession;
  readonly snapshotHash: string;
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
    const inserted = await client.query<SurveyReviewSessionRow>(
      `INSERT INTO "SurveyReviewSession"
         ("proposalId", "sessionName", snapshot, "snapshotHash", "proposalStatus", "createdBy")
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       RETURNING id, "proposalId", "sessionName", snapshot, "snapshotHash", "proposalStatus",
                 "createdBy", "createdAt", "updatedAt", "appliedAt"`,
      [proposal.id, sessionName, JSON.stringify(snapshot), snapshotHash, proposal.status, opts.actorId],
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
    `SELECT id, "proposalId", "sessionName", snapshot, "snapshotHash", "proposalStatus",
            "createdBy", "createdAt", "updatedAt", "appliedAt"
     FROM "SurveyReviewSession"
     WHERE id = $1 AND "proposalId" = $2`,
    [opts.reviewSessionId, opts.proposalId],
  );
  return result.rows[0] ? toSurveyReviewSessionRecord(result.rows[0]) : null;
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

async function findSurveyReviewSession(opts: {
  readonly proposalId: string;
  readonly sessionName: string;
}, client?: PoolClient): Promise<SurveyReviewSessionRecord | null> {
  const queryable = client ?? getPool();
  const result = await queryable.query<SurveyReviewSessionRow>(
    `SELECT id, "proposalId", "sessionName", snapshot, "snapshotHash", "proposalStatus",
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
  readonly proposalStatus: string;
  readonly createdBy: string | null;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
  readonly appliedAt: string | Date | null;
}
