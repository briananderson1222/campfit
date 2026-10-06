/**
 * steward-entry.ts — a steward enters a value a camp is missing, and that
 * entry is their attestation of it.
 *
 * The missing-requirements panel (admin camp page, review page) lists what
 * keeps a camp from VERIFIED and links the camp's own website and phone. When
 * the steward finds a value there (or by calling), they enter it. That entry
 * is recorded as human evidence by that steward: `human_attestation` evidence
 * with `metadata.reviewKind: 'steward-entry'` and an `assumed` event whose
 * method is `steward-entry` — its own kind, distinct from a crawl-cited
 * review (`crawl-proposal`), a batch accept and Mark Verified. It counts the
 * way an admin attestation counts (`countAdminAttestedRequirements`): the
 * claim's newest event is `assumed` and cites only attestation evidence.
 *
 * What a steward can enter here:
 *  - a session's start and end time (sessions have no other editor; this is
 *    the only session field this path writes);
 *  - a missing single-value camp requirement: description, camp type,
 *    category, registration status, city, website.
 * Lists (age groups, pricing) are not entered here.
 *
 * One transaction on one connection, in the lock order every claim writer
 * uses (`lockCampForClaimWrites`), events stamped by the database clock after
 * the camp's newest event (`nextClaimEventTime`), the cache re-derived in the
 * same transaction (`refreshCampVerificationCacheOnLockedClient`). The change
 * log is written after the connection is released.
 *
 * A later crawl does not overwrite the entry without review: a crawl that
 * states a different value proposes it (the entry clears the field's
 * approved-page fingerprint, so it is not withheld as already decided), and a
 * crawl that does not state a session time keeps the stored one
 * (diff-engine.ts, `keepUnstatedSessionTimes`).
 */
import { createHash } from 'node:crypto';
import type { ClaimDefinitionDraft, Evidence, VerificationEvent } from '@kontourai/surface';

import { getPool } from '@/lib/db';
import { CAMP_CATEGORY_OPTIONS, CAMP_TYPE_OPTIONS, REGISTRATION_STATUS_OPTIONS } from '@/lib/enums';
import type { DataConfidence } from '@/lib/types';
import { canonicalTime } from '@/lib/ingestion/session-time';

import { writeChangeLogs } from './changelog-repository';
import { recordEvidenceOnLockedClient } from './claim-store';
import { clearApprovedPageFingerprints } from './camp-repository';
import { isValidHttpUrl } from './onboarding-validation';
import { RepositoryConnectionError } from './repository-errors';
import { SESSION_SUBJECT_TYPE } from './session-identity';
import { campCanonicalClaimId } from './trust-projection';
import { lockCampForClaimWrites, nextClaimEventTime } from './unreviewed-change';
import { refreshCampVerificationCacheOnLockedClient } from './verification-authority';
import { sessionClaimId } from './verification-policy';
import { campfitSessionVocabulary, campfitVocabulary } from '../trust-vocabulary';

/** The single-value camp requirements a steward can enter. */
export const STEWARD_CAMP_FIELDS = ['description', 'campType', 'category', 'registrationStatus', 'city', 'websiteUrl'] as const;
export type StewardCampField = (typeof STEWARD_CAMP_FIELDS)[number];

/** Allowed values for the select fields. `UNKNOWN` is not a registration status anyone can attest. */
export const STEWARD_FIELD_OPTIONS: Partial<Record<StewardCampField, readonly { value: string; label: string }[]>> = {
  campType: CAMP_TYPE_OPTIONS,
  category: CAMP_CATEGORY_OPTIONS,
  registrationStatus: REGISTRATION_STATUS_OPTIONS.filter((option) => option.value !== 'UNKNOWN'),
};

export type StewardEntry =
  | { readonly kind: 'session-time'; readonly scheduleId: string; readonly startTime: string; readonly endTime: string }
  | { readonly kind: 'camp-field'; readonly field: StewardCampField; readonly value: string };

export class StewardEntryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StewardEntryValidationError';
  }
}

export class StewardEntryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StewardEntryNotFoundError';
  }
}

const MAX_TEXT = { description: 5000, city: 100, websiteUrl: 2048 } as const;

/**
 * Parse a request body into an entry, normalised to the stored spelling, or
 * refuse it. A time must say which half of the day it is in (`9:00 AM`,
 * `15:00`); it is never completed from a usual camp day.
 */
export function parseStewardEntry(body: unknown): StewardEntry {
  const input = (body ?? {}) as Record<string, unknown>;
  if (input.kind === 'session-time') {
    if (typeof input.scheduleId !== 'string' || !input.scheduleId.trim()) throw new StewardEntryValidationError('scheduleId is required.');
    const startTime = canonicalTime(input.startTime);
    const endTime = canonicalTime(input.endTime);
    if (!startTime || !endTime) {
      throw new StewardEntryValidationError('Enter both a start and an end time with am/pm, for example 9:00 AM and 3:00 PM.');
    }
    return { kind: 'session-time', scheduleId: input.scheduleId.trim(), startTime, endTime };
  }
  if (input.kind === 'camp-field') {
    const field = input.field;
    if (typeof field !== 'string' || !(STEWARD_CAMP_FIELDS as readonly string[]).includes(field)) {
      throw new StewardEntryValidationError(`field must be one of: ${STEWARD_CAMP_FIELDS.join(', ')}.`);
    }
    const value = typeof input.value === 'string' ? input.value.trim() : '';
    if (!value) throw new StewardEntryValidationError('Enter a value.');
    const options = STEWARD_FIELD_OPTIONS[field as StewardCampField];
    if (options && !options.some((option) => option.value === value)) {
      throw new StewardEntryValidationError(`${field} must be one of: ${options.map((option) => option.value).join(', ')}.`);
    }
    const max = MAX_TEXT[field as keyof typeof MAX_TEXT];
    if (max !== undefined && value.length > max) throw new StewardEntryValidationError(`${field} is longer than ${max} characters.`);
    if (field === 'websiteUrl' && !isValidHttpUrl(value)) throw new StewardEntryValidationError('websiteUrl must be an http(s) URL.');
    return { kind: 'camp-field', field: field as StewardCampField, value };
  }
  throw new StewardEntryValidationError('kind must be "session-time" or "camp-field".');
}

export interface StewardEntryResult {
  readonly dataConfidence: DataConfidence;
  /** Verified Camp Claim Set requirement ids still not verified after this entry. */
  readonly gapRequirementIds: string[];
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/**
 * Store a steward's entry and record it as their attestation, in one
 * transaction under the camp's claim locks. Throws
 * `StewardEntryNotFoundError` for a camp or session that does not exist (or
 * an archived session), and leaves nothing changed on any failure.
 */
export async function recordStewardEntry(
  campId: string,
  entry: StewardEntry,
  steward: string,
  options: { readonly now?: Date } = {},
): Promise<StewardEntryResult> {
  if (!steward.trim()) throw new StewardEntryValidationError('The steward must be known.');
  const pool = getPool();
  const client = await pool.connect().catch((error) => {
    throw new RepositoryConnectionError(error);
  });
  let result: StewardEntryResult;
  let changeLog: Parameters<typeof writeChangeLogs>[0][number];
  try {
    await client.query('BEGIN');
    await lockCampForClaimWrites(client, campId);
    const at = options.now ?? await nextClaimEventTime(client, campId);
    const iso = at.toISOString();

    const camp = await client.query<Record<string, unknown>>(`SELECT * FROM "Camp" WHERE id = $1 FOR UPDATE`, [campId]);
    if (!camp.rows[0]) throw new StewardEntryNotFoundError(`Camp ${campId} not found.`);

    let claim: ClaimDefinitionDraft;
    let entered: unknown;
    let described: string;
    if (entry.kind === 'session-time') {
      const { rows } = await client.query<{ id: string; label: string; startTime: string | null; endTime: string | null }>(
        `SELECT id, label, "startTime", "endTime" FROM "CampSchedule"
          WHERE id = $1 AND "campId" = $2 AND "archivedAt" IS NULL FOR UPDATE`,
        [entry.scheduleId, campId],
      );
      const session = rows[0];
      if (!session) throw new StewardEntryNotFoundError(`Session ${entry.scheduleId} is not a current session of camp ${campId}.`);
      await client.query(`UPDATE "CampSchedule" SET "startTime" = $2, "endTime" = $3 WHERE id = $1`, [session.id, entry.startTime, entry.endTime]);
      await client.query(`UPDATE "Camp" SET "updatedAt" = now() WHERE id = $1`, [campId]);
      await clearApprovedPageFingerprints(client, campId, ['schedules']);
      const claimId = sessionClaimId(session.id, 'time');
      claim = {
        id: claimId,
        subjectType: SESSION_SUBJECT_TYPE,
        subjectId: session.id,
        facet: campfitSessionVocabulary.facet,
        claimType: campfitSessionVocabulary.claimTypes.time,
        fieldOrBehavior: 'time',
        impactLevel: 'medium',
        metadata: { reviewKind: 'steward-entry', sessionLabel: session.label },
      };
      entered = { startTime: entry.startTime, endTime: entry.endTime };
      described = `the time of session "${session.label}" as ${entry.startTime}–${entry.endTime}`;
      changeLog = {
        campId, proposalId: null, changedBy: steward, fieldName: 'schedules',
        oldValue: { id: session.id, label: session.label, startTime: session.startTime, endTime: session.endTime },
        newValue: { id: session.id, label: session.label, ...(entered as object) },
        changeType: session.startTime ? 'UPDATE' : 'FIELD_POPULATED',
      };
    } else {
      const previous = camp.rows[0][entry.field];
      await client.query(`UPDATE "Camp" SET "${entry.field}" = $2, "updatedAt" = now() WHERE id = $1`, [campId, entry.value]);
      await clearApprovedPageFingerprints(client, campId, [entry.field]);
      // The legacy per-field audit trail the editor reads ("attested").
      await client.query(
        `UPDATE "Camp" SET "fieldSources" = COALESCE("fieldSources", '{}') || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ [entry.field]: { excerpt: null, sourceUrl: `steward:${steward}`, approvedAt: iso, attestedBy: steward } }), campId],
      );
      const claimId = campCanonicalClaimId(campId, entry.field);
      claim = {
        id: claimId,
        subjectType: campfitVocabulary.subjectType,
        subjectId: campId,
        facet: campfitVocabulary.facet,
        claimType: campfitVocabulary.claimTypes.scalarField,
        fieldOrBehavior: entry.field,
      };
      entered = entry.value;
      described = `${entry.field} as ${JSON.stringify(entry.value)}`;
      changeLog = {
        campId, proposalId: null, changedBy: steward, fieldName: entry.field,
        oldValue: previous ?? null, newValue: entry.value,
        changeType: previous === null || previous === undefined || previous === '' ? 'FIELD_POPULATED' : 'UPDATE',
      };
    }

    const claimId = claim.id!;
    const evidence: Evidence = {
      id: `evidence.${claimId}.steward-entry.${iso}`,
      claimId,
      evidenceType: 'human_attestation',
      method: 'attestation',
      sourceRef: `campfit-steward:${steward}`,
      sourceLocator: `steward-entry:${entry.kind === 'session-time' ? 'session-time' : entry.field}`,
      excerptOrSummary: `${steward} entered ${described}, checked against the camp's own source.`,
      observedAt: iso,
      collectedBy: steward,
      metadata: {
        reviewKind: 'steward-entry',
        trustProducer: 'campfit.steward-entry',
        enteredValue: entered,
        contentHash: contentHash(entered),
      },
    };
    const event: VerificationEvent = {
      id: `event.${claimId}.steward-entry.${iso}`,
      claimId,
      status: 'assumed',
      type: 'verification',
      actor: steward,
      method: 'steward-entry',
      evidenceIds: [evidence.id],
      createdAt: iso,
      notes: 'Entered by a steward; recorded as their attestation of this value.',
    };
    await recordEvidenceOnLockedClient(pool, client, { claim, evidence, event });

    const cache = await refreshCampVerificationCacheOnLockedClient(client, campId, options.now ? { now: options.now } : {});
    await client.query('COMMIT');
    result = {
      dataConfidence: cache.dataConfidence,
      gapRequirementIds: cache.rollup.requirements.filter((requirement) => requirement.status !== 'verified').map((requirement) => requirement.id),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  // After the connection is back in the pool: the change log takes its own.
  await writeChangeLogs([changeLog]).catch((error) => console.error('[steward-entry] writeChangeLogs failed:', error));
  return result;
}
