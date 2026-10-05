/**
 * unreviewed-change.ts — a value that changed without review is not verified.
 *
 * Surface derives a claim's status from its LATEST event. A field verified for
 * one value stays verified until an event says otherwise, so every path that
 * changes a claim-set value without attesting the new one appends a
 * `proposed` event to that field's claim, in the same transaction as the
 * value, and then re-derives the camp's cached `dataConfidence`.
 *
 * Paths that use it: a manual admin edit (`updateAdminCampFields`,
 * `replaceAdminCampAgeGroups`), an assistant edit (`updateAssistantCampFields`)
 * and a review apply, before its own evidence is recorded (review-apply.ts).
 * A claim that was never recorded has nothing to withdraw: it is not verified.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { acquireSubjectAdvisoryLock, appendEvent } from './claim-store';
import { SESSION_SUBJECT_TYPE } from './session-identity';
import { campfitVocabulary } from '../trust-vocabulary';
import { campCanonicalClaimId } from './trust-projection';
import { refreshCampVerificationCache } from './verification-authority';

type Queryable = Pool | PoolClient;

/**
 * Append a `proposed` event to each listed claim that exists, so none of them
 * reads as verified for a value nobody attested. `createdAt` is supplied by
 * the caller when the event must sort before a later one it writes itself.
 */
export async function withdrawVerification(
  queryable: Queryable,
  claimIds: readonly string[],
  opts: { actor: string; method: string; notes: string; createdAt?: string },
): Promise<string[]> {
  if (claimIds.length === 0) return [];
  const { rows } = await queryable.query<{ id: string }>(
    `SELECT id FROM "SurfaceClaimDefinition" WHERE id = ANY($1::text[])`,
    [[...claimIds]],
  );
  const createdAt = opts.createdAt ?? new Date().toISOString();
  for (const { id } of rows) {
    await appendEvent(queryable, {
      id: `event.${id}.unreviewed.${randomUUID()}`,
      claimId: id,
      status: 'proposed',
      type: 'verification',
      actor: opts.actor,
      method: opts.method,
      evidenceIds: [],
      createdAt,
      notes: opts.notes,
    });
  }
  return rows.map((row) => row.id);
}

/**
 * Serialise every change to one camp's claims: an apply, a batch accept, an
 * edit, an attestation. Taken at the start of the transaction that changes
 * values and claims.
 */
export async function lockCampClaims(client: PoolClient, campId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`camp-claims:${campId}`]);
}

/**
 * LOCK ORDER — every transaction that changes a camp's values or its claims
 * takes its locks in this order, as its first statements, so two of them can
 * wait on each other but never deadlock:
 *
 *   1. `camp-claims:<campId>`            (lockCampClaims)
 *   2. the claim-store subject locks     (acquireSubjectAdvisoryLock): the
 *      camp subject, then each of the camp's sessions in id order
 *   3. rows ("Camp", "CampChangeProposal", "CampSchedule", ...)
 *
 * The subject locks are what the claim store's locked-client writers
 * (`persistClaimOnLockedClient`, `recordEvidenceOnLockedClient`) require:
 * their save deletes claims missing from the store they loaded, so a writer
 * holding only the subject lock (e.g. `persistClaim`) must not run in
 * between. A session created later in the same transaction is locked when
 * its first claim is written; no other transaction can know its id yet.
 */
export async function lockCampForClaimWrites(client: PoolClient, campId: string): Promise<void> {
  await lockCampClaims(client, campId);
  await acquireSubjectAdvisoryLock(client, campfitVocabulary.subjectType, campId);
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM "CampSchedule" WHERE "campId" = $1 ORDER BY id`, [campId]);
  for (const { id } of rows) await acquireSubjectAdvisoryLock(client, SESSION_SUBJECT_TYPE, id);
}

/**
 * The time to stamp the next event on this camp's claims with: the database
 * clock, and never earlier than one millisecond after the newest event
 * already on the camp or its sessions. Surface reads a claim's status from
 * its newest event, so under `lockCampClaims` a later change always wins,
 * whatever the application clock says.
 */
export async function nextClaimEventTime(client: PoolClient, campId: string): Promise<Date> {
  const { rows } = await client.query<{ at: Date }>(
    `SELECT greatest(clock_timestamp(), (
        SELECT max(e."createdAt") + interval '1 millisecond'
          FROM "SurfaceVerificationEvent" e
          JOIN "SurfaceClaimDefinition" d ON d.id = e."claimId"
         WHERE d."subjectId" = $1
            OR d."subjectId" IN (SELECT id FROM "CampSchedule" WHERE "campId" = $1)
      )) AS at`,
    [campId],
  );
  return rows[0]!.at;
}

/** Withdraw the edited fields' claims inside an edit transaction: lock, stamp, append. */
export async function withdrawEditedFields(
  client: PoolClient,
  campId: string,
  fields: readonly string[],
  opts: { actor: string; method: string; notes: string },
): Promise<void> {
  await lockCampForClaimWrites(client, campId);
  const at = await nextClaimEventTime(client, campId);
  await withdrawVerification(client, editedCampClaimIds(campId, fields), { ...opts, createdAt: at.toISOString() });
}

/** The camp claims a manual edit of these fields changes. */
export function editedCampClaimIds(campId: string, fields: readonly string[]): string[] {
  return fields.map((field) => campCanonicalClaimId(campId, field));
}

/**
 * Re-derive the cached `dataConfidence` after a manual edit committed. A
 * failure is logged, not thrown: the edit and its `proposed` events are
 * already durable, and the next derivation reads them.
 */
export async function refreshAfterUnreviewedChange(campId: string): Promise<void> {
  try {
    await refreshCampVerificationCache(campId);
  } catch (error) {
    console.error(`[unreviewed-change] refreshCampVerificationCache failed for camp ${campId}:`, error);
  }
}
