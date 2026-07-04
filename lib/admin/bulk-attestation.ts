/**
 * lib/admin/bulk-attestation.ts — the shared "bulk human attestation" path
 * for the two Wave 4 writer call sites this task owns: `POST /api/admin/
 * camps/[campId]` (`mark_verified` action) and the assistant tool's
 * `mark_camp_verified` case
 * (`.kontourai/flow-agents/verification-authority/
 * verification-authority--deliver-plan.md`, Wave 4 "`mark_verified` route +
 * assistant tool bulk attestation").
 *
 * Kept as its own small module (NOT appended to `lib/admin/
 * verification-authority.ts`) because that module is the Wave 3 "core"
 * task's file and is otherwise frozen for this wave; this module only
 * CONSUMES its public exports (`deriveCampVerification`,
 * `refreshCampVerificationCache`) plus `claim-store.ts`'s `recordEvidence`
 * and `verification-policy.ts`'s `VERIFIED_CAMP_FIELDS` — it does not
 * reimplement any evaluation logic.
 *
 * ── What "bulk attestation" replaces, and why it no longer writes the enum ──
 *
 * Both call sites used to run an unconditional
 * `UPDATE "Camp" SET "dataConfidence" = 'VERIFIED' ...` — a hand-maintained
 * boolean flip with no auditable evidence behind it. `bulkAttestCamp` instead
 * records real, human-backed Evidence for every field in the Verified Camp
 * Claim Set (`verification-policy.ts`'s `VERIFIED_CAMP_FIELDS` — the 8
 * Camp-scalar/repeated field requirements; the 9th requirement,
 * `sessions-verified`, is not a Camp field and is never bulk-attested here —
 * a Session's own verification is a separate, per-Session concern), then
 * asks `verification-authority.ts` to DERIVE the actual resulting status
 * rather than assuming the flip succeeded. `Camp.dataConfidence` is still
 * written ONLY by `refreshCampVerificationCache` (AC1) — this module never
 * writes the enum directly.
 *
 * ── Evidence uses `@kontourai/surface`'s `buildHumanAttestationEvidence` ───
 *
 * `@kontourai/surface`'s `buildHumanAttestationEvidence` (v2.3.0,
 * `attestation.d.ts`) is used unmodified: deterministic evidence id,
 * `integrityRef`/`metadata.contentHash`, `sourceRef`/`actor` plumbing,
 * `evidenceType: 'attestation'`, `method: 'attestation'`. None of
 * `claim-store.ts`'s fail-loud-only fields (`supportStrength`/
 * `integrityAnchor`/`passing`/`blocking`/`execution` — see its header
 * comment gap 3) are ever set by it, so it round-trips through
 * `appendEvidence` cleanly.
 *
 * ── Why the VerificationEvent is explicitly `'assumed'`, not `'verified'` ──
 *
 * `recordEvidence`'s default event synthesis (when no `event` is passed)
 * would set `status: 'verified'` for `method: 'attestation'` evidence — but
 * `verification-policy.ts`'s production `policy.camp.scalar-field`/
 * `policy.camp.repeated-field` both declare
 * `requiredEvidence: ['crawl_observation', 'human_attestation']`, and
 * Surface's `deriveTrustStatus` (`status.js`) demotes a `'verified'` event
 * back to `'proposed'` whenever ANY listed evidence type is missing from the
 * claim's entailing evidence — which a pure admin attestation (no crawl ever
 * ran) always would be. Passing an explicit `status: 'assumed'` event
 * instead sidesteps that check entirely (`deriveTrustStatus` returns
 * `'assumed'` unconditionally for an `'assumed'` event, before any
 * evidence-type gate) — mirroring the SAME convention this slice's other
 * writer call sites already use for admin-only attestation
 * (`trust-projection.ts`'s `campClaim({ status: 'assumed', ... })`,
 * `lib/admin/entity-admin-repository.ts`'s `recordCampAttestationEvidence`,
 * both Survey-flavored). At the `ClaimGroupRollup` level this is not a
 * weaker outcome: `claim-groups.js`'s `deriveRequirementStatus` PROMOTES an
 * all-`'assumed'` requirement to `'verified'` (`aggregate === 'assumed' ⇒
 * 'verified'`), so a fully-attested, zero-Session Camp still derives
 * `dataConfidence: 'VERIFIED'` end-to-end through
 * `refreshCampVerificationCache` — see
 * `tests/integration/verification-authority.test.ts`'s AC4 cases.
 */
import { createHash } from 'node:crypto';

import {
  buildHumanAttestationEvidence,
  type ClaimDefinitionDraft,
  type VerificationEvent,
} from '@kontourai/surface';

import { getPool } from '@/lib/db';
import type { Camp, DataConfidence } from '@/lib/types';

import { recordEvidence } from './claim-store';
import { campCanonicalClaimId } from './trust-projection';
import { refreshCampVerificationCache } from './verification-authority';
import { VERIFIED_CAMP_FIELDS, type VerifiedCampField } from './verification-policy';
import { campfitVocabulary } from '../trust-vocabulary';

function claimTypeForField(field: VerifiedCampField): string {
  return field === 'ageGroups' || field === 'pricing'
    ? campfitVocabulary.claimTypes.repeatedField
    : campfitVocabulary.claimTypes.scalarField;
}

/**
 * Deterministic content hash of a field's current serialized value —
 * `buildHumanAttestationEvidence` requires `contentHash` (a stand-in for "the
 * admin attested THIS exact value", per the plan narrative). Blank/`null`
 * values still hash (and still get attested) — an intentionally-blank field
 * is a legitimate attested state per `policy.camp.scalar-field`'s own
 * acceptance criteria ("An intentionally blank value is acceptable only when
 * explicitly attested as such."), not skipped.
 */
function contentHashFor(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export interface BulkAttestCampResult {
  readonly campId: string;
  readonly dataConfidence: DataConfidence;
  /** Always `VERIFIED_CAMP_FIELDS.length` — every required Camp Attribute gets one Evidence row per call. */
  readonly attestedFieldCount: number;
  /** Verified Camp Claim Set requirement ids whose status is NOT `'verified'` after this attestation — empty when the Camp is fully VERIFIED. */
  readonly gapRequirementIds: string[];
}

/**
 * Records one human-attestation `Evidence` row (via `recordEvidence`) for
 * every field in the Verified Camp Claim Set, then derives — never assumes —
 * the resulting `Camp.dataConfidence` via `refreshCampVerificationCache`
 * (the sole writer, AC1). Shared by `POST /api/admin/camps/[campId]`'s
 * `mark_verified` action and the assistant tool's `mark_camp_verified` case.
 */
export async function bulkAttestCamp(
  campId: string,
  actorEmail: string,
  options: { now?: Date } = {},
): Promise<BulkAttestCampResult> {
  const pool = getPool();
  const now = options.now ?? new Date();
  const attestedAt = now.toISOString();

  const { rows } = await pool.query<Partial<Camp>>(`SELECT * FROM "Camp" WHERE id = $1`, [campId]);
  const camp = rows[0];
  if (!camp) {
    throw new Error(`bulkAttestCamp(${campId}): Camp not found.`);
  }

  for (const field of VERIFIED_CAMP_FIELDS) {
    const claimId = campCanonicalClaimId(campId, field);
    const claim: ClaimDefinitionDraft = {
      id: claimId,
      subjectType: campfitVocabulary.subjectType,
      subjectId: campId,
      facet: campfitVocabulary.facet,
      claimType: claimTypeForField(field),
      fieldOrBehavior: field,
    };

    const evidence = buildHumanAttestationEvidence({
      subject: { claimId, sourceRef: `admin:${actorEmail}` },
      actor: { id: actorEmail },
      attestedAt,
      contentHash: contentHashFor((camp as Record<string, unknown>)[field]),
    });

    // See this module's header comment: explicit 'assumed' status, not
    // recordEvidence's 'verified'-for-attestation default.
    const event: VerificationEvent = {
      id: `event.${evidence.id}.bulk-attestation`,
      claimId,
      status: 'assumed',
      type: 'verification',
      actor: actorEmail,
      method: evidence.method,
      evidenceIds: [evidence.id],
      createdAt: attestedAt,
    };

    await recordEvidence(pool, { claim, evidence, event });
  }

  // LOW fix (review-code.md: redundant double evaluation) — previously this
  // called `deriveCampVerification` once here (read-only, for the caller's
  // reply message) AND `refreshCampVerificationCache` immediately after
  // (which calls `deriveCampVerification` again internally): two full
  // Camp+Sessions bundle loads/derivations for one `bulkAttestCamp` call.
  // `refreshCampVerificationCache` now returns the `ClaimGroupRollup` it
  // already computed while doing the authoritative (persisted) derivation,
  // so this reuses THAT instead of deriving a second time.
  const cacheResult = await refreshCampVerificationCache(campId, { now });
  const gapRequirementIds = cacheResult.rollup.requirements
    .filter((requirement) => requirement.status !== 'verified')
    .map((requirement) => requirement.id);

  return {
    campId,
    dataConfidence: cacheResult.dataConfidence,
    attestedFieldCount: VERIFIED_CAMP_FIELDS.length,
    gapRequirementIds,
  };
}
