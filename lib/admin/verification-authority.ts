/**
 * lib/admin/verification-authority.ts — the sole computer of Camp/Session
 * Verification status (see docs/contexts/trust-review-provenance/CONTEXT.md:
 * "Verification", "Verification Policy", "Verification Gap", "Claim",
 * "Evidence"; and docs/contexts/data-stewardship/CONTEXT.md). Replaces
 * `lib/admin/verification.ts` (deleted once Wave 4's writer cutover removes
 * its last import — AC1,
 * `.kontourai/flow-agents/verification-authority/verification-authority--deliver-plan.md`).
 *
 * ── What this module does, and why it looks the way it does ────────────────
 *
 * `deriveCampVerification`/`deriveSessionVerification` assemble ONE
 * `TrustBundle` per evaluation (Camp fields + every non-archived Session's
 * own Claims) and hand it to `@kontourai/surface`'s `deriveTrustSnapshot`,
 * which internally runs `foldClaim` (per-Claim evidence/event fold),
 * `applyDerivation` (the `derivedFrom` ceiling — "a derived Claim cannot be
 * more confident than the weakest Claim it is built on"), and
 * `deriveClaimGroupRollups` (the Verified Camp / Verified Session Claim Set
 * requirement rollup) in one pass. This module NEVER calls `foldClaim`/
 * `applyDerivation` directly — see the plan's Wave 3 context note.
 *
 * Two kinds of Claim never have a persisted row (`SurfaceClaimDefinition`
 * carries no `derivedFrom` column at all — see `claim-store.ts`'s header
 * comment gap 5 on why the full `Claim` shape's `derivedFrom`/`value` aren't
 * persisted): they are synthesized fresh, in-memory, on every evaluation:
 *
 * 1. **Inherited Session Attribute Claims** (`buildInheritedSessionClaims`):
 *    `eligibility`/`registration-status`/`price-options`/`registration-path`
 *    have no per-Session schema field today (decision 4's own "explicit
 *    Verification Gap for unknowns" language) — each is `derivedFrom` the
 *    corresponding Camp-level Claim, `metadata.inherited: 'camp-level'`. Only
 *    synthesized when no REAL, session-specific Claim already exists for that
 *    id (a future per-session data source, e.g. `CampPricing.scheduleId`,
 *    simply shadows this fallback the day a real Claim gets persisted).
 * 2. **Rollup Claims** (`session.<id>.verified`, `camp.<id>.sessions-verified`):
 *    each is given an own status of `verified` via a synthesized
 *    `calculation_trace` Evidence + `verification` Event (an unregistered,
 *    module-local claim type — no `VerificationPolicy` resolves against it,
 *    so `deriveTrustStatus` accepts the event's status at face value), then
 *    `applyDerivation`'s ceiling bounds it down to the weakest of its
 *    `derivedFrom` inputs. Forcing the own status to the STRONGEST possible
 *    value (`verified`) is what makes `weakerStatus(ownStatus, ceiling)`
 *    always equal the ceiling — i.e. the rollup Claim's final status IS
 *    exactly the weakest-linked status of what it rolls up, never
 *    additionally constrained by its own (nonexistent) evidence. Because the
 *    Camp's `sessions-verified` Claim's `derivedFrom` list is rebuilt from
 *    the CURRENT non-archived `CampSchedule` rows on every evaluation, an
 *    archived Session simply stops contributing to it on the next
 *    evaluation — no separate "recompute derivedFrom" step is needed.
 *
 * `refreshCampVerificationCache(campId)` is the ONLY writer of
 * `Camp.dataConfidence`/`lastVerifiedAt` (AC1) — every writer route (Wave 4)
 * calls it after recording Evidence, never writing the enum directly.
 *
 * `recordEvidence`/`projectTrustStatusToDataConfidence` are re-exported here
 * (not reimplemented — they live in `claim-store.ts`/`verification-policy.ts`
 * respectively) so Wave 4's writer call sites have exactly one module to
 * import from, matching AC1's "sole computer" framing.
 *
 * `revokeArchivedSessionClaims` is the "archived-session claim revocation
 * helper" this module's Wave 3 task list names: it bridges
 * `session-identity.ts`'s `deriveArchivedSessionDisposition` (pure) to an
 * actual read (`loadClaimBundle`) + append (`appendEvent`) round-trip. It
 * only revokes Claims that are ALREADY persisted for the archived Session —
 * a Session archived before any Claim was ever persisted for it (nothing yet
 * calls `persistClaim` for the 4 inherited/2 real Session Attribute Claims
 * eagerly; they are synthesized on read, per above) produces no events. This
 * is a safe no-op, not a silent failure: there is nothing to revoke when
 * nothing was ever asserted.
 *
 * `coverageFromRollup` is `camp-editor.tsx`'s `CoverageMeter` data-source
 * adapter (Wave 4), reproducing the deleted `computeCoverage`'s
 * `{covered, missing, unattested, pct}` shape from a `ClaimGroupRollup`
 * instead of `fieldSources` JSON.
 */
import type { Pool } from 'pg';

import {
  CURRENT_SCHEMA_VERSION,
  deriveTrustSnapshot,
  type Claim,
  type ClaimGroupRollup,
  type Evidence,
  type EvidenceType,
  type SubjectRef,
  type TrustBundle,
  type VerificationEvent,
  type VerificationPolicy,
} from '@kontourai/surface';

import { getPool } from '@/lib/db';
import type { Camp, DataConfidence } from '@/lib/types';

import { appendEvent, loadClaimBundle, recordEvidence } from './claim-store';
import {
  deriveArchivedSessionDisposition,
  SESSION_SUBJECT_TYPE,
  type ExistingScheduleRow,
} from './session-identity';
import { campCanonicalClaimId } from './trust-projection';
import {
  buildVerifiedCampClaimGroup,
  buildVerifiedSessionClaimGroup,
  campSessionsVerifiedClaimId,
  INHERITED_SESSION_ATTRIBUTES,
  projectTrustStatusToDataConfidence,
  sessionClaimId,
  sessionVerifiedClaimId,
  VERIFIED_CAMP_CLAIM_GROUP_ID,
  VERIFIED_CAMP_SESSION_POLICIES,
  VERIFIED_SESSION_ATTRIBUTES,
  VERIFIED_SESSION_CLAIM_GROUP_ID,
  type VerifiedCampField,
  type VerifiedSessionAttribute,
} from './verification-policy';
import { campfitSessionVocabulary, campfitVocabulary } from '../trust-vocabulary';

// Re-exported (not reimplemented) — see this module's header comment.
export { recordEvidence, projectTrustStatusToDataConfidence };

const EVALUATION_SOURCE = 'campfit.admin.verification-authority';
const EVALUATION_ACTOR = 'campfit-verification-authority';

// ---------------------------------------------------------------------------
// Rollup claim types — module-local, unregistered (no VerificationPolicy
// resolves against them; see header comment point 2).
// ---------------------------------------------------------------------------

const SESSION_ROLLUP_CLAIM_TYPE = 'public-directory.session-verified-rollup';
const CAMP_SESSIONS_ROLLUP_CLAIM_TYPE = 'public-directory.camp-sessions-verified-rollup';

/** Mirrors `verification-policy.ts`'s `buildVerifiedCampClaimGroup`'s `sessions-verified` requirement id. */
const SESSIONS_VERIFIED_REQUIREMENT_ID = 'sessions-verified';

// ---------------------------------------------------------------------------
// Inherited Session Attribute Claims (header comment point 1)
// ---------------------------------------------------------------------------

/**
 * Which Camp-level Attribute each inherited-by-design Session Attribute
 * falls back to (ADR-0002's "identity, location, description, classification,
 * contact-or-registration-path" mapped onto concrete fields — see
 * `verification-policy.ts`'s header comment for the full mapping rationale).
 */
type InheritedSessionAttribute = 'eligibility' | 'registration-status' | 'price-options' | 'registration-path';

const INHERITED_ATTRIBUTE_CAMP_FIELD: Record<InheritedSessionAttribute, VerifiedCampField> = {
  eligibility: 'ageGroups',
  'registration-status': 'registrationStatus',
  'price-options': 'pricing',
  'registration-path': 'websiteUrl',
};

const SESSION_ATTRIBUTE_CLAIM_TYPE: Record<VerifiedSessionAttribute, string> = {
  dates: campfitSessionVocabulary.claimTypes.dates,
  time: campfitSessionVocabulary.claimTypes.time,
  eligibility: campfitSessionVocabulary.claimTypes.eligibility,
  'registration-status': campfitSessionVocabulary.claimTypes.registrationStatus,
  'price-options': campfitSessionVocabulary.claimTypes.priceOptions,
  'registration-path': campfitSessionVocabulary.claimTypes.registrationPath,
};

/**
 * The 4 inherited Session Attribute policies (`verification-policy.ts`'s
 * `VERIFIED_CAMP_SESSION_POLICIES`) all declare the SAME `requiredEvidence`
 * set — supplying all 3 types keeps the inherited Claim's own status able to
 * reach `verified` (see header comment point 2's "strongest possible own
 * status" reasoning), regardless of which of the 4 attributes it is.
 */
const INHERITED_REQUIRED_EVIDENCE: readonly EvidenceType[] = [
  'crawl_observation',
  'human_attestation',
  'calculation_trace',
];

export interface InheritedSessionClaimsResult {
  readonly claims: Claim[];
  readonly evidence: Evidence[];
  readonly events: VerificationEvent[];
}

/**
 * Synthesizes the 4 inherited-from-camp Session Attribute Claims for one
 * Session, skipping any attribute that already has a REAL, persisted Claim
 * (`existingClaimIds`) — a real per-Session data source, once it exists,
 * always shadows this fallback rather than being silently overridden by it.
 */
export function buildInheritedSessionClaims(params: {
  readonly campId: string;
  readonly scheduleId: string;
  readonly existingClaimIds: ReadonlySet<string>;
  readonly now?: Date;
}): InheritedSessionClaimsResult {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const claims: Claim[] = [];
  const evidence: Evidence[] = [];
  const events: VerificationEvent[] = [];

  for (const attribute of INHERITED_SESSION_ATTRIBUTES) {
    const claimId = sessionClaimId(params.scheduleId, attribute);
    if (params.existingClaimIds.has(claimId)) continue;

    // `INHERITED_SESSION_ATTRIBUTES`'s element type is the full `VerifiedSessionAttribute`
    // union (verification-policy.ts declares it `readonly VerifiedSessionAttribute[]`,
    // not a narrowed literal-tuple type) even though its 4 runtime values are always
    // a subset — this cast reflects that runtime invariant, not a type escape hatch.
    const campField = INHERITED_ATTRIBUTE_CAMP_FIELD[attribute as InheritedSessionAttribute];
    const sourceClaimId = campCanonicalClaimId(params.campId, campField);

    const claimEvidence: Evidence[] = INHERITED_REQUIRED_EVIDENCE.map((evidenceType, index) => ({
      id: `${claimId}.inherited-evidence.${index}`,
      claimId,
      evidenceType,
      method: 'validation',
      sourceRef: sourceClaimId,
      excerptOrSummary:
        `Inherited from Camp-level claim "${sourceClaimId}" — decision 4: no per-Session ` +
        `"${attribute}" data source exists yet (docs/contexts/trust-review-provenance/CONTEXT.md: Verification Gap).`,
      observedAt: nowIso,
      collectedBy: EVALUATION_ACTOR,
      metadata: { inherited: 'camp-level' },
    }));

    events.push({
      id: `${claimId}.inherited-event`,
      claimId,
      status: 'verified',
      type: 'verification',
      actor: EVALUATION_ACTOR,
      method: 'inherited-derivation',
      evidenceIds: claimEvidence.map((item) => item.id),
      createdAt: nowIso,
    });

    claims.push({
      id: claimId,
      subjectType: SESSION_SUBJECT_TYPE,
      subjectId: params.scheduleId,
      facet: campfitSessionVocabulary.facet,
      claimType: SESSION_ATTRIBUTE_CLAIM_TYPE[attribute],
      fieldOrBehavior: attribute,
      value: undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
      derivedFrom: [sourceClaimId],
      metadata: { inherited: 'camp-level' },
    });
    evidence.push(...claimEvidence);
  }

  return { claims, evidence, events };
}

// ---------------------------------------------------------------------------
// Rollup claim synthesis (header comment point 2)
// ---------------------------------------------------------------------------

interface RollupClaimResult {
  readonly claim: Claim;
  readonly evidence: Evidence;
  readonly event: VerificationEvent;
}

function buildRollupClaim(params: {
  readonly id: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly facet: string;
  readonly claimType: string;
  readonly fieldOrBehavior: string;
  readonly derivedFrom: readonly string[];
  readonly now: Date;
  readonly summary: string;
}): RollupClaimResult {
  const nowIso = params.now.toISOString();

  const evidence: Evidence = {
    id: `${params.id}.rollup-evidence`,
    claimId: params.id,
    evidenceType: 'calculation_trace',
    method: 'validation',
    sourceRef: EVALUATION_SOURCE,
    excerptOrSummary: params.summary,
    observedAt: nowIso,
    collectedBy: EVALUATION_ACTOR,
  };

  const event: VerificationEvent = {
    id: `${params.id}.rollup-event`,
    claimId: params.id,
    status: 'verified',
    type: 'verification',
    actor: EVALUATION_ACTOR,
    method: 'calculation',
    evidenceIds: [evidence.id],
    createdAt: nowIso,
  };

  const claim: Claim = {
    id: params.id,
    subjectType: params.subjectType,
    subjectId: params.subjectId,
    facet: params.facet,
    claimType: params.claimType,
    fieldOrBehavior: params.fieldOrBehavior,
    value: undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    derivedFrom: params.derivedFrom.length > 0 ? [...params.derivedFrom] : undefined,
    impactLevel: 'medium',
  };

  return { claim, evidence, event };
}

function buildSessionRollupClaim(scheduleId: string, memberClaimIds: readonly string[], now: Date): RollupClaimResult {
  return buildRollupClaim({
    id: sessionVerifiedClaimId(scheduleId),
    subjectType: SESSION_SUBJECT_TYPE,
    subjectId: scheduleId,
    facet: campfitSessionVocabulary.facet,
    claimType: SESSION_ROLLUP_CLAIM_TYPE,
    fieldOrBehavior: 'verified',
    derivedFrom: memberClaimIds,
    now,
    summary:
      `Computed rollup over Session "${scheduleId}"'s Verified Session Claim Set ` +
      `(${memberClaimIds.length} requirements) via applyDerivation's ceiling.`,
  });
}

function buildCampSessionsVerifiedClaim(campId: string, sessionRollupClaimIds: readonly string[], now: Date): RollupClaimResult {
  return buildRollupClaim({
    id: campSessionsVerifiedClaimId(campId),
    subjectType: campfitVocabulary.subjectType,
    subjectId: campId,
    facet: campfitVocabulary.facet,
    claimType: CAMP_SESSIONS_ROLLUP_CLAIM_TYPE,
    fieldOrBehavior: 'sessions-verified',
    derivedFrom: sessionRollupClaimIds,
    now,
    summary:
      `Computed rollup over Camp "${campId}"'s ${sessionRollupClaimIds.length} non-archived ` +
      `Session(s) via applyDerivation's ceiling.`,
  });
}

// ---------------------------------------------------------------------------
// Bundle assembly
// ---------------------------------------------------------------------------

function mergePolicies(bundlePolicies: readonly VerificationPolicy[]): VerificationPolicy[] {
  const byId = new Map(VERIFIED_CAMP_SESSION_POLICIES.map((policy) => [policy.id, policy] as const));
  for (const policy of bundlePolicies) {
    if (!byId.has(policy.id)) byId.set(policy.id, policy);
  }
  return [...byId.values()];
}

interface EvaluationBundle {
  readonly claims: Claim[];
  readonly evidence: Evidence[];
  readonly events: VerificationEvent[];
  readonly policies: VerificationPolicy[];
  /** One `session.<id>.verified` rollup claim id per requested `scheduleId`, in order — the Camp-level ceiling's `derivedFrom` list. */
  readonly sessionRollupClaimIds: string[];
}

/**
 * Loads the persisted Claims for the Camp + the given (non-archived)
 * Sessions, then layers the synthetic inherited-attribute Claims and
 * per-Session rollup Claims on top (header comment points 1-2). Shared by
 * `deriveCampVerification` (all of a Camp's non-archived Sessions) and
 * `deriveSessionVerification` (exactly one Session — which still needs the
 * Camp's own field Claims loaded, since the inherited Claims' `derivedFrom`
 * points at them).
 */
async function buildEvaluationBundle(pool: Pool, campId: string, scheduleIds: readonly string[], now: Date): Promise<EvaluationBundle> {
  const subjectRefs: SubjectRef[] = [
    { subjectType: campfitVocabulary.subjectType, subjectId: campId },
    ...scheduleIds.map((scheduleId) => ({ subjectType: SESSION_SUBJECT_TYPE, subjectId: scheduleId })),
  ];

  const bundle = await loadClaimBundle(pool, subjectRefs);
  const existingClaimIds = new Set(bundle.claims.map((claim) => claim.id));

  const claims: Claim[] = [...bundle.claims];
  const evidence: Evidence[] = [...bundle.evidence];
  const events: VerificationEvent[] = [...bundle.events];
  const sessionRollupClaimIds: string[] = [];

  for (const scheduleId of scheduleIds) {
    const inherited = buildInheritedSessionClaims({ campId, scheduleId, existingClaimIds, now });
    claims.push(...inherited.claims);
    evidence.push(...inherited.evidence);
    events.push(...inherited.events);

    const memberClaimIds = VERIFIED_SESSION_ATTRIBUTES.map((attribute) => sessionClaimId(scheduleId, attribute));
    const rollup = buildSessionRollupClaim(scheduleId, memberClaimIds, now);
    claims.push(rollup.claim);
    evidence.push(rollup.evidence);
    events.push(rollup.event);
    sessionRollupClaimIds.push(rollup.claim.id);
  }

  return { claims, evidence, events, policies: mergePolicies(bundle.policies), sessionRollupClaimIds };
}

async function nonArchivedScheduleIds(pool: Pool, campId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY id`,
    [campId],
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Public evaluators
// ---------------------------------------------------------------------------

export interface DeriveVerificationOptions {
  readonly now?: Date;
}

/**
 * Composes the Camp's own 8 field-level Claims + a `sessions-verified` Claim
 * `derivedFrom` every non-archived Session's own rollup Claim (via
 * `applyDerivation`'s ceiling), and returns the resulting
 * `ClaimGroupRollup` for the Verified Camp Claim Set (`verification-
 * policy.ts`'s `buildVerifiedCampClaimGroup`).
 */
export async function deriveCampVerification(campId: string, options: DeriveVerificationOptions = {}): Promise<ClaimGroupRollup> {
  const now = options.now ?? new Date();
  const pool = getPool();

  const scheduleIds = await nonArchivedScheduleIds(pool, campId);
  const built = await buildEvaluationBundle(pool, campId, scheduleIds, now);
  const campRollup = buildCampSessionsVerifiedClaim(campId, built.sessionRollupClaimIds, now);

  // NOTE: deliberately NOT run through `validateTrustBundle` — that check
  // enforces every `derivedFrom` reference resolves to a present claim
  // (structural integrity for a bundle about to be persisted/exported), but
  // this evaluation bundle can legitimately contain a rollup Claim whose
  // `derivedFrom` points at a Session Attribute Claim that was never
  // persisted or synthesized (an explicit Verification Gap, decision 4's own
  // language — see this module's header comment). `deriveTrustSnapshot`'s own
  // `applyDerivation` already handles a missing derivation input gracefully
  // (a `transparencyGap` + the ceiling capped to `unknown`, NOT a thrown
  // error) — that graceful handling is exactly what makes a missing Claim
  // surface as an explicit gap instead of a hard failure.
  const bundleInput: TrustBundle = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    source: EVALUATION_SOURCE,
    claims: [...built.claims, campRollup.claim],
    evidence: [...built.evidence, campRollup.evidence],
    policies: built.policies,
    events: [...built.events, campRollup.event],
    claimGroups: [buildVerifiedCampClaimGroup(campId)],
  };

  const derivation = deriveTrustSnapshot(bundleInput, { now });
  const rollup = derivation.claimGroupRollups.find((candidate) => candidate.id === VERIFIED_CAMP_CLAIM_GROUP_ID);
  if (!rollup) {
    throw new Error(`deriveCampVerification(${campId}): expected a "${VERIFIED_CAMP_CLAIM_GROUP_ID}" ClaimGroupRollup, got none.`);
  }
  return rollup;
}

/**
 * Same evaluation as `deriveCampVerification`, scoped to exactly one
 * (non-archived) Session, returning the `ClaimGroupRollup` for the Verified
 * Session Claim Set (`verification-policy.ts`'s `buildVerifiedSessionClaimGroup`).
 * Throws if `scheduleId` does not resolve to a non-archived `CampSchedule`
 * row — a Session's own verification is undefined once it is archived
 * (revoked, see `revokeArchivedSessionClaims`), not silently reported.
 */
export async function deriveSessionVerification(scheduleId: string, options: DeriveVerificationOptions = {}): Promise<ClaimGroupRollup> {
  const now = options.now ?? new Date();
  const pool = getPool();

  const { rows } = await pool.query<{ campId: string }>(
    `SELECT "campId" FROM "CampSchedule" WHERE id = $1 AND "archivedAt" IS NULL`,
    [scheduleId],
  );
  const campId = rows[0]?.campId;
  if (!campId) {
    throw new Error(`deriveSessionVerification(${scheduleId}): no non-archived CampSchedule row found.`);
  }

  const built = await buildEvaluationBundle(pool, campId, [scheduleId], now);

  // See the analogous comment in `deriveCampVerification` above: this
  // evaluation bundle is deliberately not run through `validateTrustBundle`.
  const bundleInput: TrustBundle = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    source: EVALUATION_SOURCE,
    claims: built.claims,
    evidence: built.evidence,
    policies: built.policies,
    events: built.events,
    claimGroups: [buildVerifiedSessionClaimGroup(scheduleId)],
  };

  const derivation = deriveTrustSnapshot(bundleInput, { now });
  const rollup = derivation.claimGroupRollups.find((candidate) => candidate.id === VERIFIED_SESSION_CLAIM_GROUP_ID);
  if (!rollup) {
    throw new Error(`deriveSessionVerification(${scheduleId}): expected a "${VERIFIED_SESSION_CLAIM_GROUP_ID}" ClaimGroupRollup, got none.`);
  }
  return rollup;
}

export interface RefreshCampVerificationCacheResult {
  readonly dataConfidence: DataConfidence;
  readonly lastVerifiedAt: Date;
  /**
   * The `ClaimGroupRollup` this call derived in order to compute
   * `dataConfidence` — exposed (LOW fix, review-code.md: `bulk-attestation.ts`'s
   * redundant double evaluation) so a caller that also needs the full rollup
   * (e.g. `gapRequirementIds`) can read it from HERE instead of calling
   * `deriveCampVerification` a second time. This does not weaken AC1's "sole
   * writer" invariant — `refreshCampVerificationCache` is still the only
   * function that WRITES `Camp.dataConfidence`/`lastVerifiedAt`; it now also
   * hands back the rollup it already computed along the way.
   */
  readonly rollup: ClaimGroupRollup;
}

/**
 * The ONLY writer of `Camp.dataConfidence`/`lastVerifiedAt` (AC1). Called
 * from, and only from, the post-evidence-change points the plan's "Which call
 * sites refresh the cache" table names (Wave 4) — `mark_verified`, the
 * assistant's `mark_camp_verified`, `/attest`, `addFieldAttestation`, and
 * `review-apply.ts`'s `recomputeVerification`.
 */
export async function refreshCampVerificationCache(campId: string, options: DeriveVerificationOptions = {}): Promise<RefreshCampVerificationCacheResult> {
  const now = options.now ?? new Date();
  const rollup = await deriveCampVerification(campId, { now });
  const dataConfidence = projectTrustStatusToDataConfidence(rollup.status);

  const pool = getPool();
  await pool.query(`UPDATE "Camp" SET "dataConfidence" = $1, "lastVerifiedAt" = $2 WHERE id = $3`, [dataConfidence, now, campId]);

  return { dataConfidence, lastVerifiedAt: now, rollup };
}

// ---------------------------------------------------------------------------
// Archived-session claim revocation (session-identity.ts's disposition, wired to storage)
// ---------------------------------------------------------------------------

/**
 * Bridges `session-identity.ts`'s `applyScheduleReconciliation` `orphaned`
 * output to the persisted Claim ledger: appends a `revoked` `VerificationEvent`
 * (via `deriveArchivedSessionDisposition`) for every ALREADY-PERSISTED Claim
 * belonging to one of the archived Sessions. See this module's header comment
 * for why a Session with no persisted Claims yet produces no events (a safe
 * no-op, not a silent failure).
 */
export async function revokeArchivedSessionClaims(params: {
  readonly orphaned: readonly ExistingScheduleRow[];
  readonly actor: string;
  readonly method: string;
  readonly now?: Date;
}): Promise<VerificationEvent[]> {
  if (params.orphaned.length === 0) return [];

  const pool = getPool();
  const subjectRefs: SubjectRef[] = params.orphaned.map((row) => ({ subjectType: SESSION_SUBJECT_TYPE, subjectId: row.id }));
  const bundle = await loadClaimBundle(pool, subjectRefs);
  if (bundle.claims.length === 0) return [];

  const events = deriveArchivedSessionDisposition({
    orphaned: params.orphaned,
    claims: bundle.claims,
    actor: params.actor,
    method: params.method,
    now: params.now,
  });

  for (const event of events) {
    await appendEvent(pool, event);
  }

  return events;
}

// ---------------------------------------------------------------------------
// camp-editor.tsx CoverageMeter data-source adapter
// ---------------------------------------------------------------------------

export interface CoverageResult {
  /** Requirement ids whose claim(s) are ALL in `RequirementRollup.verifiedClaims`. */
  readonly covered: string[];
  /** Requirement ids with a non-empty Camp value but not (yet) fully verified. */
  readonly missing: string[];
  /** Requirement ids that are blank AND not verified — need explicit "N/A" attestation or data. */
  readonly unattested: string[];
  readonly pct: number;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * `camp-editor.tsx`'s `CoverageMeter` data-source adapter (Wave 4), replacing
 * the deleted `lib/admin/verification.ts`'s `computeCoverage`. Built from
 * `RequirementRollup.verifiedClaims`/`missingClaimIds` and the requirement's
 * underlying Camp value's emptiness, per this slice's plan narrative.
 *
 * Note: a requirement whose sole Claim status is `assumed` (not `verified`)
 * is reported by Surface's `deriveClaimGroupRollups` as an overall-`verified`
 * REQUIREMENT status (an "assumed" single claim is promoted to `verified` at
 * the requirement-rollup level — `claim-groups.js`'s `deriveRequirementStatus`),
 * but does NOT appear in `verifiedClaims` (that array is a strict `status ===
 * 'verified'` filter). This function follows the plan's literal
 * `verifiedClaims`-based wording, so such a requirement lands in `missing`
 * here rather than `covered` — a deliberately conservative reading, not a bug.
 */
export function coverageFromRollup(rollup: ClaimGroupRollup, campValues: Partial<Camp>): CoverageResult {
  const covered: string[] = [];
  const missing: string[] = [];
  const unattested: string[] = [];

  for (const requirement of rollup.requirements) {
    const isCovered =
      requirement.claimIds.length > 0 && requirement.claimIds.every((id) => requirement.verifiedClaims.includes(id));
    if (isCovered) {
      covered.push(requirement.id);
      continue;
    }

    if (requirement.id === SESSIONS_VERIFIED_REQUIREMENT_ID) {
      // No Camp scalar/repeated field backs this requirement (it rolls up
      // Sessions, not a Camp column) — an uncovered sessions-verified
      // requirement is reported as "missing" (needs Session-level review),
      // never "unattested" (there is no Camp field an admin could fill in).
      missing.push(requirement.id);
      continue;
    }

    const value = (campValues as Record<string, unknown>)[requirement.id];
    if (isEmptyValue(value)) {
      unattested.push(requirement.id);
    } else {
      missing.push(requirement.id);
    }
  }

  const total = rollup.requirements.length;
  const pct = total === 0 ? 0 : Math.round((covered.length / total) * 100);
  return { covered, missing, unattested, pct };
}
