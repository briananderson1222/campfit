import type { ReviewSessionEvent } from '@kontourai/survey';

import { getPool } from '@/lib/db';
import {
  deriveServerReviewSessionApplyResult,
  ServerReviewSessionEventValidationError,
  StaleServerReviewSessionError,
} from '@/lib/kontourai/survey-review-server-session';
import {
  assertSurveyReviewSessionFreshForProposal,
  getSurveyReviewSessionForProposal,
  type SurveyReviewSessionRecord,
} from './survey-review-sessions';
import type { CampChangeProposal } from './types';

export async function getSurveyReviewEvents(opts: string | {
  readonly proposalId: string;
  readonly reviewSessionId?: string;
}): Promise<ReviewSessionEvent[]> {
  if (typeof opts === 'string') {
    return getLegacyProposalSurveyReviewEvents(opts);
  }

  if (!opts.reviewSessionId) {
    return getLegacyProposalSurveyReviewEvents(opts.proposalId);
  }

  const result = await getPool().query<{ event: ReviewSessionEvent }>(
    `SELECT event
     FROM "SurveyReviewEvent"
     WHERE "proposalId" = $1 AND "reviewSessionId" = $2
     ORDER BY "sessionName" ASC, sequence ASC`,
    [opts.proposalId, opts.reviewSessionId],
  );

  return result.rows.map((row) => row.event).filter(isReviewSessionEvent);
}

export async function replaceSurveyReviewEvents(opts: {
  proposalId: string;
  proposal?: CampChangeProposal;
  reviewSessionId: string;
  events: readonly ReviewSessionEvent[];
  actorEmail: string;
  expectedEventCount?: number;
}): Promise<void> {
  const reviewSession = await getSurveyReviewSessionForProposal({
    proposalId: opts.proposalId,
    reviewSessionId: opts.reviewSessionId,
  });
  if (!reviewSession) {
    throw new SurveyReviewEventValidationError('Survey review session was not found for this proposal.');
  }
  if (opts.proposal) {
    assertSurveyReviewSessionFreshForProposal(reviewSession, opts.proposal);
  }
  validateSurveyReviewEventsForSession(reviewSession, opts.events);

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [opts.reviewSessionId]);

    const existing = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "SurveyReviewEvent" WHERE "proposalId" = $1 AND "reviewSessionId" = $2`,
      [opts.proposalId, opts.reviewSessionId],
    );
    const existingCount = Number(existing.rows[0]?.count ?? '0');
    if (opts.expectedEventCount !== undefined && existingCount !== opts.expectedEventCount) {
      throw new SurveyReviewEventConflictError(existingCount);
    }

    await client.query(
      `DELETE FROM "SurveyReviewEvent" WHERE "proposalId" = $1 AND "reviewSessionId" = $2`,
      [opts.proposalId, opts.reviewSessionId],
    );

    for (const event of opts.events) {
      const spec = event.spec;

      await client.query(
        `INSERT INTO "SurveyReviewEvent" (
           "proposalId",
           "reviewSessionId",
           "sessionName",
           sequence,
           "eventName",
           "eventType",
           "reviewItemName",
           "activeItemName",
           "reviewDecisionName",
           "candidateId",
           status,
           rationale,
           actor,
           "occurredAt",
           event
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15::jsonb)`,
        [
          opts.proposalId,
          opts.reviewSessionId,
          spec.sessionName,
          spec.sequence,
          event.metadata.name,
          spec.eventType,
          spec.reviewItemName ?? null,
          spec.activeItemName ?? null,
          spec.reviewDecisionName ?? null,
          spec.candidateId ?? null,
          spec.status ?? null,
          spec.rationale ?? null,
          opts.actorEmail,
          spec.occurredAt,
          JSON.stringify(event),
        ],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class SurveyReviewEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurveyReviewEventValidationError';
  }
}

export class SurveyReviewEventConflictError extends Error {
  constructor(readonly currentEventCount: number) {
    super('Survey review events changed before this snapshot could be saved.');
    this.name = 'SurveyReviewEventConflictError';
  }
}

export function isReviewSessionEventArray(value: unknown): value is ReviewSessionEvent[] {
  return Array.isArray(value) && value.every(isReviewSessionEvent);
}

function isReviewSessionEvent(value: unknown): value is ReviewSessionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'ReviewSessionEvent') return false;
  if (!record.metadata || typeof record.metadata !== 'object') return false;
  if (!record.spec || typeof record.spec !== 'object') return false;

  const spec = record.spec as Record<string, unknown>;
  return (
    typeof spec.sessionName === 'string' &&
    typeof spec.sequence === 'number' &&
    typeof spec.eventType === 'string' &&
    typeof spec.occurredAt === 'string'
  );
}

async function getLegacyProposalSurveyReviewEvents(proposalId: string): Promise<ReviewSessionEvent[]> {
  const result = await getPool().query<{ event: ReviewSessionEvent }>(
    `SELECT event
     FROM "SurveyReviewEvent"
     WHERE "proposalId" = $1
     ORDER BY "sessionName" ASC, sequence ASC`,
    [proposalId],
  );

  return result.rows.map((row) => row.event).filter(isReviewSessionEvent);
}

export function validateSurveyReviewEventsForSession(
  reviewSession: SurveyReviewSessionRecord,
  events: readonly ReviewSessionEvent[],
): void {
  try {
    deriveServerReviewSessionApplyResult({
      record: {
        sessionName: reviewSession.sessionName,
        snapshot: reviewSession.snapshot,
        snapshotHash: reviewSession.snapshotHash,
        eventCount: events.length,
        updatedAt: reviewSession.updatedAt,
      },
      events,
    });
  } catch (error) {
    if (error instanceof ServerReviewSessionEventValidationError || error instanceof StaleServerReviewSessionError) {
      throw new SurveyReviewEventValidationError(error.message);
    }
    throw error;
  }
}
