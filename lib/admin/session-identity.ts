/**
 * lib/admin/session-identity.ts — stable "Session" (`CampSchedule`) identity
 * for `review-apply.ts`'s `applyRelationField` `schedules` branch.
 *
 * `CampSchedule` has no natural external id from crawl/proposal sources
 * (Proposal-carried schedule objects are plain `{label, startDate, endDate,
 * startTime, endTime, earlyDropOff, latePickup}`; see `review-apply.ts`'s
 * `IncomingScheduleSnapshot`). Prior to this module, `applyRelationField`
 * treated `schedules` exactly like `ageGroups`/`pricing` — `DELETE ... WHERE
 * "campId" = $1` followed by a fresh `INSERT` per incoming row — which meant
 * a `CampSchedule.id` never survived across two sequential Review Applies for
 * what a human/crawl would call "the same session" (see the plan's "Stable
 * Session identity" narrative, `.kontourai/flow-agents/verification-
 * authority/verification-authority--deliver-plan.md` lines ~191-222). That
 * matters once Session-scoped Claims exist (Wave 3's Verified Session Claim
 * Set): a Claim's `subjectId` is the `CampSchedule.id`, so a rewritten id
 * silently orphans that session's entire claim history on every re-crawl.
 *
 * This module is a THIN wrapper around `@kontourai/surface`'s own
 * `matchClaimSubjects`/`deriveOrphanedSubjectDisposition` (shipped in the
 * `surface-store-adapter` PR2 delivery) — the natural-key matching algorithm
 * and the claim-disposition vocabulary are CONSUMED directly, not
 * reimplemented locally. Only the campfit-specific pieces are local: the
 * natural-key definition itself (trimmed, case-insensitive `label` +
 * `startDate` + `endDate` — two sessions never share a label AND date range
 * in existing crawl data, and `label` is required non-null on every
 * Proposal-carried schedule) and the SQL translation of `matchClaimSubjects`'s
 * `{matched, orphaned, created}` result:
 *
 *   - `matched`  → `UPDATE "CampSchedule" ... WHERE id = $id` (id preserved)
 *   - `orphaned` → `UPDATE "CampSchedule" SET "archivedAt" = now() WHERE id =
 *                   $id` (never `DELETE` — `CampSchedule.archivedAt`, added
 *                   by migration 012, is the soft-archive column)
 *   - `created`  → `INSERT ... VALUES (gen_random_uuid()::text, ...)` (as
 *                   before)
 *
 * `ageGroups`/`pricing` are UNTOUCHED by this module and stay delete-all +
 * insert in `review-apply.ts` — decision 5 scopes the keyed-upsert change to
 * `schedules` only.
 *
 * Archived-session claim disposition (the "what happens to an archived
 * session's claims" half of decision 5): `deriveArchivedSessionDisposition`
 * below is exposed here as the thin wrapper Wave 3's
 * `lib/admin/verification-authority.ts` (its own "archived-session claim
 * revocation helper", per the plan's Wave 3 task list) calls once
 * `lib/admin/claim-store.ts` (Wave 2's *other* task, built concurrently with
 * this one) exists to load a session's current Claims and persist the
 * resulting `VerificationEvent`s. This module deliberately does NOT import
 * `claim-store.ts` or perform any claim persistence itself: in this wave, no
 * `SurfaceClaimDefinition` rows exist yet for `public-directory.camp-session`
 * subjects at all (the Verified Session Claim Set is Wave 3's `AC5`), so
 * there is nothing yet to revoke — wiring `deriveArchivedSessionDisposition`
 * into an actual claim read+append round-trip is Wave 3's job, once both
 * prerequisites (session claims existing, `claim-store.ts` existing) are
 * true. `applyScheduleReconciliation`'s `orphaned` return value (the
 * existing rows the caller should treat as archived) is exactly what a
 * caller needs to build that round-trip later; this module just doesn't
 * assume the round-trip's other half exists yet.
 */
import type { PoolClient } from 'pg';

import {
  matchClaimSubjects,
  deriveOrphanedSubjectDisposition,
  type ClaimDefinition,
  type VerificationEvent,
} from '@kontourai/surface';

/**
 * The `subjectType` convention Session-scoped Claims use (plan line ~154).
 * Exported so Wave 3's `verification-authority.ts` and this module's own
 * `deriveArchivedSessionDisposition` agree on the exact same string.
 */
export const SESSION_SUBJECT_TYPE = 'public-directory.camp-session';

/** A Proposal-carried schedule snapshot — mirrors the shape `applyRelationField`'s `schedules` diff.new items have always had. */
export interface IncomingScheduleSnapshot {
  readonly label: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly earlyDropOff: string | null;
  readonly latePickup: string | null;
}

/** An existing, non-archived `CampSchedule` row, as read back from Postgres before matching. */
export interface ExistingScheduleRow {
  readonly id: string;
  readonly label: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

export interface ScheduleReconciliationResult {
  /** `CampSchedule.id`s that were matched and updated in place (id preserved). */
  readonly matchedIds: readonly string[];
  /** `CampSchedule.id`s freshly inserted for incoming rows with no natural-key match. */
  readonly createdIds: readonly string[];
  /**
   * Existing rows with no incoming match this round — already archived
   * (`archivedAt` set) by the time this result is returned. Exposed for a
   * caller that wants to additionally dispose of their claims (Wave 3, see
   * this module's header comment) without re-querying for them.
   */
  readonly orphaned: readonly ExistingScheduleRow[];
}

/** Trimmed, case-insensitive `label` + `startDate` + `endDate` — the natural key a human/crawl already treats as "the same session" (plan line ~194). */
function scheduleNaturalKey(label: string, startDate: string | null, endDate: string | null): string {
  return `${label.trim().toLowerCase()}|${startDate ?? ''}|${endDate ?? ''}`;
}

/**
 * Reconciles one Camp's incoming `schedules` snapshot against its existing,
 * non-archived `CampSchedule` rows: matches by natural key via
 * `@kontourai/surface`'s `matchClaimSubjects`, then translates the result
 * into `UPDATE`/soft-archive/`INSERT` SQL. Runs inside the caller's
 * transaction (`client` is the same `PoolClient` `applyProposalReview`
 * already has `BEGIN`-ed).
 */
export async function applyScheduleReconciliation(
  client: PoolClient,
  campId: string,
  incoming: readonly IncomingScheduleSnapshot[],
): Promise<ScheduleReconciliationResult> {
  const { rows: existing } = await client.query<ExistingScheduleRow>(
    `SELECT id, label, to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate"
     FROM "CampSchedule"
     WHERE "campId" = $1 AND "archivedAt" IS NULL`,
    [campId],
  );

  const { matched, orphaned, created } = matchClaimSubjects<IncomingScheduleSnapshot, ExistingScheduleRow>({
    existing,
    incoming,
    existingKey: (row) => scheduleNaturalKey(row.label, row.startDate, row.endDate),
    incomingKey: (row) => scheduleNaturalKey(row.label, row.startDate, row.endDate),
    existingId: (row) => row.id,
  });

  for (const { id, incoming: schedule } of matched) {
    await client.query(
      `UPDATE "CampSchedule"
       SET label = $2, "startDate" = $3::date, "endDate" = $4::date, "startTime" = $5, "endTime" = $6,
           "earlyDropOff" = $7, "latePickup" = $8
       WHERE id = $1`,
      [id, schedule.label, schedule.startDate, schedule.endDate, schedule.startTime, schedule.endTime, schedule.earlyDropOff, schedule.latePickup],
    );
  }

  for (const row of orphaned) {
    await client.query(`UPDATE "CampSchedule" SET "archivedAt" = now() WHERE id = $1`, [row.id]);
  }

  const createdIds: string[] = [];
  for (const schedule of created) {
    const { rows: [insertedRow] } = await client.query<{ id: string }>(
      `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff", "latePickup")
       VALUES (gen_random_uuid()::text, $1, $2, $3::date, $4::date, $5, $6, $7, $8)
       RETURNING id`,
      [campId, schedule.label, schedule.startDate, schedule.endDate, schedule.startTime, schedule.endTime, schedule.earlyDropOff, schedule.latePickup],
    );
    createdIds.push(insertedRow!.id);
  }

  return {
    matchedIds: matched.map((m) => m.id),
    createdIds,
    orphaned,
  };
}

/**
 * Bridges an `applyScheduleReconciliation` result's `orphaned` rows to claim
 * lifecycle: for every Claim belonging to one of those Sessions, produces a
 * `revoked` `VerificationEvent` via `@kontourai/surface`'s
 * `deriveOrphanedSubjectDisposition`. Pure — appending the returned events to
 * a session's claim ledger (and recomputing the Camp's `sessions-verified`
 * `derivedFrom` list to drop the archived session's rollup claim) is the
 * caller's job, once `lib/admin/claim-store.ts` exists to load `claims` for
 * these subjects and persist the result (Wave 3 — see this module's header
 * comment for why that round-trip isn't wired up in this module yet).
 */
export function deriveArchivedSessionDisposition(input: {
  readonly orphaned: readonly ExistingScheduleRow[];
  readonly claims: readonly ClaimDefinition[];
  readonly actor: string;
  readonly method: string;
  readonly now?: Date;
}): VerificationEvent[] {
  return deriveOrphanedSubjectDisposition({
    orphanedSubjects: input.orphaned.map((row) => ({ subjectType: SESSION_SUBJECT_TYPE, subjectId: row.id })),
    claims: input.claims,
    status: 'revoked',
    actor: input.actor,
    method: input.method,
    now: input.now,
  });
}
