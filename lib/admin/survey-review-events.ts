import type { ReviewSessionEvent } from '@kontourai/survey';

import { getPool } from '@/lib/db';

export async function getSurveyReviewEvents(proposalId: string): Promise<ReviewSessionEvent[]> {
  const result = await getPool().query<{ event: ReviewSessionEvent }>(
    `SELECT event
     FROM "SurveyReviewEvent"
     WHERE "proposalId" = $1
     ORDER BY "sessionName" ASC, sequence ASC`,
    [proposalId],
  );

  return result.rows.map((row) => row.event).filter(isReviewSessionEvent);
}

export async function replaceSurveyReviewEvents(opts: {
  proposalId: string;
  events: readonly ReviewSessionEvent[];
  actorEmail: string;
  expectedEventCount?: number;
}): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [opts.proposalId]);

    const existing = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "SurveyReviewEvent" WHERE "proposalId" = $1`,
      [opts.proposalId],
    );
    const existingCount = Number(existing.rows[0]?.count ?? '0');
    if (opts.expectedEventCount !== undefined && existingCount !== opts.expectedEventCount) {
      throw new SurveyReviewEventConflictError(existingCount);
    }

    await client.query(`DELETE FROM "SurveyReviewEvent" WHERE "proposalId" = $1`, [opts.proposalId]);

    for (const event of opts.events) {
      const spec = event.spec;
      const actor = spec.actor?.id ?? spec.actor?.displayName ?? opts.actorEmail;

      await client.query(
        `INSERT INTO "SurveyReviewEvent" (
           "proposalId",
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14::jsonb)`,
        [
          opts.proposalId,
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
          actor,
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
