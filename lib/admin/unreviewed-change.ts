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

import { appendEvent } from './claim-store';
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
