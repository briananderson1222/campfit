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
 * `refreshCampVerificationCacheOnLockedClient(client, campId)` is the ONLY
 * writer of `Camp.dataConfidence`/`lastVerifiedAt` (AC1) — every writer route
 * (Wave 4) calls it inside the transaction that records the Evidence, never
 * writing the enum directly.
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
import type { Pool, PoolClient } from 'pg';

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
  // A camp with no sessions has nothing to roll up: the requirement rests on
  // an explicit "intentionally empty" attestation of its session list (the
  // camp's `schedules` claim, kept in the bundle only when that is its
  // governing event, see `buildEvaluationBundle`), and is a gap without one.
  const derivedFrom = sessionRollupClaimIds.length > 0 ? sessionRollupClaimIds : [campCanonicalClaimId(campId, 'schedules')];
  return buildRollupClaim({
    id: campSessionsVerifiedClaimId(campId),
    subjectType: campfitVocabulary.subjectType,
    subjectId: campId,
    facet: campfitVocabulary.facet,
    claimType: CAMP_SESSIONS_ROLLUP_CLAIM_TYPE,
    fieldOrBehavior: 'sessions-verified',
    derivedFrom,
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
async function buildEvaluationBundle(pool: Pool | PoolClient, campId: string, scheduleIds: readonly string[], now: Date): Promise<EvaluationBundle> {
  const subjectRefs: SubjectRef[] = [
    { subjectType: campfitVocabulary.subjectType, subjectId: campId },
    ...scheduleIds.map((scheduleId) => ({ subjectType: SESSION_SUBJECT_TYPE, subjectId: scheduleId })),
  ];

  const loaded = await loadClaimBundle(pool, subjectRefs);
  const bundle = await withoutUnattestedEmptyLists(pool, campId, loaded);
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

/** The method of the event that records an explicit "this list is intentionally empty" attestation (steward-entry.ts). */
export const INTENTIONALLY_EMPTY_METHOD = 'intentionally-empty';

/**
 * An empty required list (age groups, pricing, the session list) is a
 * Verification Gap unless it is explicitly attested as intentionally empty
 * (verification-policy.ts: "An empty list is acceptable only when explicitly
 * attested as intentionally empty"; "An unknown price is an explicit
 * Verification Gap"). So while a list is empty, its claim takes part in the
 * evaluation only when its newest event is that attestation; any other
 * history (a Mark Verified that attested nothing, an approval of a list that
 * has since emptied) leaves the requirement a gap, and the session
 * attributes inherited from it too.
 */
async function withoutUnattestedEmptyLists(
  pool: Pool | PoolClient,
  campId: string,
  bundle: Awaited<ReturnType<typeof loadClaimBundle>>,
): Promise<Awaited<ReturnType<typeof loadClaimBundle>>> {
  const { rows } = await pool.query<{ ageGroups: number; pricing: number; schedules: number }>(
    `SELECT (SELECT count(*)::int FROM "CampAgeGroup" WHERE "campId" = $1) AS "ageGroups",
            (SELECT count(*)::int FROM "CampPricing" WHERE "campId" = $1) AS pricing,
            (SELECT count(*)::int FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL) AS schedules`,
    [campId],
  );
  const counts = rows[0] ?? { ageGroups: 0, pricing: 0, schedules: 0 };
  const dropped = new Set<string>();
  for (const field of ['ageGroups', 'pricing', 'schedules'] as const) {
    const claimId = campCanonicalClaimId(campId, field);
    const newest = bundle.events
      .filter((event) => event.claimId === claimId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const attestedEmpty = newest?.method === INTENTIONALLY_EMPTY_METHOD;
    // Empty: only an "intentionally empty" attestation counts. Not empty: that
    // attestation describes a list that no longer exists, so it does not.
    if (counts[field] === 0 ? !attestedEmpty : attestedEmpty) dropped.add(claimId);
  }
  if (dropped.size === 0) return bundle;
  return {
    ...bundle,
    claims: bundle.claims.filter((claim) => !dropped.has(claim.id)),
    evidence: bundle.evidence.filter((item) => !dropped.has(item.claimId)),
    events: bundle.events.filter((event) => !dropped.has(event.claimId)),
  };
}

async function nonArchivedScheduleIds(pool: Pool | PoolClient, campId: string): Promise<string[]> {
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
  /**
   * Read through this client instead of the pool. A caller that holds a
   * connection (and the camp lock) must pass it: deriving through the pool
   * would take a second connection while holding the first, and with the
   * pool's three connections, three such callers wait on each other until
   * one times out.
   */
  readonly client?: PoolClient;
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
  const pool = options.client ?? getPool();

  const scheduleIds = await nonArchivedScheduleIds(pool, campId);
  const built = await buildEvaluationBundle(pool, campId, scheduleIds, now);
  if (verificationCacheTestHooks.afterLoad) await verificationCacheTestHooks.afterLoad(campId);
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
  return countAdminAttestedRequirements(rollup, bundleInput, derivation);
}

/**
 * The camp's rollup and every current session's rollup from ONE bundle and
 * one derivation (the missing-requirements guidance reads both; deriving
 * each session separately reloaded the camp's claims once per session).
 * Read-only: it never writes the cache.
 */
export async function deriveCampAndSessionVerification(
  campId: string,
  options: DeriveVerificationOptions = {},
): Promise<{ camp: ClaimGroupRollup; sessions: Map<string, ClaimGroupRollup> }> {
  const now = options.now ?? new Date();
  const pool = options.client ?? getPool();
  const scheduleIds = await nonArchivedScheduleIds(pool, campId);
  const built = await buildEvaluationBundle(pool, campId, scheduleIds, now);
  const campRollup = buildCampSessionsVerifiedClaim(campId, built.sessionRollupClaimIds, now);
  const bundleInput: TrustBundle = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    source: EVALUATION_SOURCE,
    claims: [...built.claims, campRollup.claim],
    evidence: [...built.evidence, campRollup.evidence],
    policies: built.policies,
    events: [...built.events, campRollup.event],
    // Every session's group shares one id; each gets its own here so the rollups can be told apart.
    claimGroups: [buildVerifiedCampClaimGroup(campId), ...scheduleIds.map((id) => ({ ...buildVerifiedSessionClaimGroup(id), id: `${VERIFIED_SESSION_CLAIM_GROUP_ID}.${id}` }))],
  };
  const derivation = deriveTrustSnapshot(bundleInput, { now });
  const rollupOf = (groupId: string, label: string) => {
    const rollup = derivation.claimGroupRollups.find((candidate) => candidate.id === groupId);
    if (!rollup) throw new Error(`deriveCampAndSessionVerification(${campId}): no "${label}" ClaimGroupRollup.`);
    return countAdminAttestedRequirements(rollup, bundleInput, derivation);
  };
  const sessions = new Map<string, ClaimGroupRollup>();
  for (const id of scheduleIds) sessions.set(id, rollupOf(`${VERIFIED_SESSION_CLAIM_GROUP_ID}.${id}`, id));
  return { camp: rollupOf(VERIFIED_CAMP_CLAIM_GROUP_ID, 'camp'), sessions };
}

/**
 * Admin attestation is recorded as an `assumed` VerificationEvent backed only
 * by `method: 'attestation'` evidence (see `bulk-attestation.ts`'s header for
 * why it is not `verified`: the Camp field policies require crawl AND human
 * evidence, which a pure attestation never has). Until Surface 2.15 the
 * requirement rollup promoted every all-`assumed` requirement to `verified`,
 * which is what let an attested Camp reach VERIFIED. Surface 2.15 stopped
 * that promotion because it also verified requirements whose claims were only
 * unreviewed gaps.
 *
 * This keeps the attestation outcome and nothing else. A claim whose derived
 * status is `assumed` counts as verified only when
 *  - its own standing is sound: it is governed by an admin attestation (its
 *    latest event is `assumed` and cites only `method: 'attestation'`
 *    evidence recorded for that claim; the /attest path writes that event
 *    with `method: 'survey-assumption'`, bulk attestation with
 *    `method: 'attestation'`), or its own status before the derivation
 *    ceiling is `verified` (an inherited Session attribute, a Session or
 *    Camp rollup), and
 *  - every claim it derives from counts as verified by this same rule.
 * So a Session attribute inherited from an attested Camp field, and the
 * rollups over it, count; anything resting on an unreviewed, unattested input
 * does not. A requirement whose status is `assumed` counts as verified only
 * when all of its claims do, and the group becomes `verified` only when
 * every required requirement is then verified. A `stale`, `proposed` or
 * weaker claim is never promoted: the ceiling already put it below `assumed`.
 *
 * The encoding that removes this rule is a policy change (the field policies
 * accept an admin attestation on its own), which is left to a separate
 * decision.
 */
export function countAdminAttestedRequirements(
  rollup: ClaimGroupRollup,
  bundle: Pick<TrustBundle, 'events' | 'evidence'>,
  derivation: {
    readonly claims: readonly (Pick<Claim, 'id' | 'derivedFrom'> & { readonly status: string })[];
    readonly untimedOwnStatusByClaimId: Readonly<Record<string, string>>;
  },
): ClaimGroupRollup {
  const attested = (claimId: string): boolean => {
    const latest = bundle.events
      .filter((event) => event.claimId === claimId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!latest || latest.status !== 'assumed') return false;
    const ids = latest.evidenceIds ?? [];
    return ids.length > 0 && ids.every((id) =>
      bundle.evidence.some((item) => item.id === id && item.claimId === claimId && item.method === 'attestation'));
  };
  const derived = new Map(derivation.claims.map((claim) => [claim.id, claim] as const));
  const memo = new Map<string, boolean>();
  const counts = (claimId: string, visiting: Set<string>): boolean => {
    const known = memo.get(claimId);
    if (known !== undefined) return known;
    const claim = derived.get(claimId);
    if (!claim || visiting.has(claimId)) return false;
    let result = claim.status === 'verified';
    if (claim.status === 'assumed') {
      visiting.add(claimId);
      const ownSound = attested(claimId) || derivation.untimedOwnStatusByClaimId[claimId] === 'verified';
      result = ownSound && (claim.derivedFrom ?? []).every((input) => counts(input, visiting));
      visiting.delete(claimId);
    }
    memo.set(claimId, result);
    return result;
  };
  let changed = false;
  const requirements = rollup.requirements.map((requirement) => {
    if (requirement.status !== 'assumed' || requirement.claimIds.length === 0 || requirement.missingClaimIds.length > 0) {
      return requirement;
    }
    if (!requirement.claimIds.every((id) => counts(id, new Set()))) return requirement;
    changed = true;
    return {
      ...requirement,
      status: 'verified' as const,
      verifiedClaims: [...requirement.claimIds],
      unsupportedClaims: requirement.unsupportedClaims.filter((id) => !requirement.claimIds.includes(id)),
    };
  });
  if (!changed) return rollup;
  const required = requirements.filter((requirement) => requirement.required);
  const status = rollup.status === 'assumed' && required.length > 0 && required.every((requirement) => requirement.status === 'verified')
    ? 'verified'
    : rollup.status;
  const verifiedRequirements = requirements.filter((requirement) => requirement.status === 'verified').length;
  return {
    ...rollup,
    status,
    requirements,
    summary: {
      ...rollup.summary,
      verifiedRequirements,
      unsupportedRequirements: rollup.summary.unsupportedRequirements - (verifiedRequirements - rollup.summary.verifiedRequirements),
      verificationCoverage: requirements.length === 0 ? 0 : verifiedRequirements / requirements.length,
    },
  };
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
  return countAdminAttestedRequirements(rollup, bundleInput, derivation);
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
   * writer" invariant — `refreshCampVerificationCacheOnLockedClient` is still the only
   * function that WRITES `Camp.dataConfidence`/`lastVerifiedAt`; it now also
   * hands back the rollup it already computed along the way.
   */
  readonly rollup: ClaimGroupRollup;
}

/**
 * Test-only seams, inert in production. `afterLoad` runs inside
 * `deriveCampVerification`, after it has read the claims; `beforeWrite` runs
 * between deriving the cached status and writing it.
 */
export const verificationCacheTestHooks: {
  afterLoad?: (campId: string) => Promise<void>;
  beforeWrite?: (campId: string, dataConfidence: DataConfidence) => Promise<void>;
} = {};

/** The cache is written only by a transaction that holds this camp's `camp-claims` lock. */
export class CampLockNotHeldError extends Error {
  constructor(campId: string) {
    super(`The verification cache of camp ${campId} is written only under its camp-claims lock.`);
    this.name = 'CampLockNotHeldError';
  }
}

/**
 * The ONLY writer of `Camp.dataConfidence`/`lastVerifiedAt` (AC1). It runs
 * inside the transaction that changed the camp's values or claims (a review
 * apply, a batch accept, an admin or assistant edit, Mark Verified, the
 * attest route), on that transaction's client, after its changes and before
 * its COMMIT. So:
 *  - the cache and the change it reflects commit together or not at all: a
 *    derivation that fails rolls the change back, and a VERIFIED cache never
 *    outlives the change that withdrew it (fail closed);
 *  - it reads through the same connection, never a second one from the pool;
 *  - it derives under the camp lock the caller took first (the lock order in
 *    unreviewed-change.ts), and refuses to run without it, so no other change
 *    to the camp's claims can commit between the derivation and the write.
 */
export async function refreshCampVerificationCacheOnLockedClient(
  client: PoolClient,
  campId: string,
  options: { readonly now?: Date } = {},
): Promise<RefreshCampVerificationCacheResult> {
  const { rows } = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)
     ) AS held`,
    [`camp-claims:${campId}`],
  );
  if (!rows[0]?.held) throw new CampLockNotHeldError(campId);
  const now = options.now ?? new Date();
  const rollup = await deriveCampVerification(campId, { now, client });
  const dataConfidence = projectTrustStatusToDataConfidence(rollup.status);
  if (verificationCacheTestHooks.beforeWrite) await verificationCacheTestHooks.beforeWrite(campId, dataConfidence);
  await client.query(`UPDATE "Camp" SET "dataConfidence" = $1, "lastVerifiedAt" = $2 WHERE id = $3`, [dataConfidence, now, campId]);
  return { dataConfidence, lastVerifiedAt: now, rollup };
}

/**
 * Re-derive the cache on its own, outside any change (a script or a repair):
 * one connection, one transaction, under the camp lock.
 */
export async function refreshCampVerificationCache(campId: string, options: { readonly now?: Date } = {}): Promise<RefreshCampVerificationCacheResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`camp-claims:${campId}`]);
    const result = await refreshCampVerificationCacheOnLockedClient(client, campId, options);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
