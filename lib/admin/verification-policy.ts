/**
 * lib/admin/verification-policy.ts — Verified Camp/Session Claim Set policy data.
 *
 * This module is pure data (plus one pure mapping function): it has no
 * database dependency and performs no I/O. It expresses ADR-0002
 * ("Verified camps and sessions are aggregates of verified claims",
 * docs/adr/0002-verified-camp-session-claim-sets.md) as concrete
 * `@kontourai/surface` `ClaimGroup`/`VerificationPolicy` values, using the
 * vocabulary docs/contexts/trust-review-provenance/CONTEXT.md and
 * docs/contexts/data-stewardship/CONTEXT.md define:
 *
 * - **Verified Camp Claim Set** (trust-review-provenance CONTEXT.md): "the
 *   required claim groups for a Verified Camp: identity, location,
 *   description, classification, and contact or registration path." Expressed
 *   below as `buildVerifiedCampClaimGroup(campId)` — 9 `ClaimRequirement`s:
 *   the 8 existing `REQUIRED_FOR_VERIFIED` Camp Attributes (see
 *   `lib/admin/verification.ts`, being replaced by this slice) plus one
 *   `sessions-verified` requirement standing in for the retired `schedules`
 *   requirement (a Camp's Sessions now carry their own Verified Session Claim
 *   Set instead of one coarse `schedules` field-attestation).
 * - **Verified Session Claim Set** (trust-review-provenance CONTEXT.md):
 *   "session dates, session time or a clear reason time does not apply,
 *   eligibility, registration status, price options, and registration path.
 *   Unknown registration or price values require an explicit Verification
 *   Gap." Expressed below as `buildVerifiedSessionClaimGroup(scheduleId)` — 6
 *   `ClaimRequirement`s, one per Session Attribute.
 *
 * Every `ClaimGroup` requirement's `claimIds` reuses the EXACT claim-identity
 * conventions already in production (`campCanonicalClaimId` from
 * `./trust-projection`, `trust-projection.ts:361-405`) rather than inventing
 * a parallel scheme — the 8 Camp field requirements are literally
 * `[campCanonicalClaimId(campId, field)]`. Session claim ids are a new,
 * analogous convention (`session.<scheduleId>.<attribute>`) since Sessions
 * are a new claim Subject this slice introduces.
 *
 * `projectTrustStatusToDataConfidence` is the pure mapping from Surface's
 * 9-valued `TrustStatus` (docs/contexts/trust-review-provenance/CONTEXT.md:
 * "Verification Status") down to CampFit's existing 3-valued
 * `Camp.dataConfidence` (`VERIFIED | PLACEHOLDER | STALE`,
 * `prisma/migrations/001_initial_schema.sql`). It is re-exported by
 * `lib/admin/verification-authority.ts` (this slice's Wave 3) as that
 * module's single caller-facing surface for the mapping.
 *
 * NOT this module's job (lives in `lib/admin/verification-authority.ts`,
 * Wave 3, once `lib/admin/claim-store.ts` exists): assembling a Camp's or
 * Session's actual `Claim[]`/`Evidence[]`/`VerificationEvent[]` from
 * Postgres, running `deriveTrustSnapshot`/`deriveClaimGroupRollups` over
 * them, or writing `Camp.dataConfidence`. This module only supplies the
 * requirement/policy shapes those functions consume.
 */

import type {
  ClaimGroup,
  ClaimRequirement,
  EvidenceType,
  ImpactLevel,
  TrustStatus,
  ValidityRule,
  VerificationPolicy,
} from '@kontourai/surface';

import type { DataConfidence } from '@/lib/types';
import { campfitSessionVocabulary, campfitVocabulary } from '../trust-vocabulary';
import { campCanonicalClaimId } from './trust-projection';

// ---------------------------------------------------------------------------
// Verified Camp Claim Set
// ---------------------------------------------------------------------------

/**
 * The 8 existing `REQUIRED_FOR_VERIFIED` Camp Attributes (see the
 * now-superseded `lib/admin/verification.ts`), MINUS `schedules` — the exact
 * same field names/order, reused rather than reinvented, per this task's
 * instruction not to invent new field names. `schedules` is replaced by the
 * `sessions-verified` requirement below (a Camp's Sessions now carry their
 * own Verified Session Claim Set).
 */
export const VERIFIED_CAMP_FIELDS = [
  'description',
  'campType',
  'category',
  'registrationStatus',
  'city',
  'websiteUrl',
  'ageGroups',
  'pricing',
] as const;

export type VerifiedCampField = (typeof VERIFIED_CAMP_FIELDS)[number];

/** Human-readable requirement titles, in the same order as `VERIFIED_CAMP_FIELDS`. */
const VERIFIED_CAMP_FIELD_TITLES: Record<VerifiedCampField, string> = {
  description: 'Description',
  campType: 'Camp type',
  category: 'Category',
  registrationStatus: 'Registration status',
  city: 'City',
  websiteUrl: 'Website URL',
  ageGroups: 'Age groups',
  pricing: 'Pricing',
};

/** Stable id for the Camp's synthesized Sessions rollup Claim (Wave 3 derives its status). */
export function campSessionsVerifiedClaimId(campId: string): string {
  return `camp.${campId}.sessions-verified`;
}

export const VERIFIED_CAMP_CLAIM_GROUP_ID = 'verified-camp';

/**
 * Builds the Verified Camp Claim Set as a `ClaimGroup` scoped to one Camp.
 * `deriveClaimGroupRollups` needs concrete `claimIds` to match against the
 * Camp's actual `Claim[]`, so this is a factory keyed by `campId` rather than
 * a single static object — the requirement SHAPE (9 slots, all-required) is
 * fixed; only the ids are parameterized.
 */
export function buildVerifiedCampClaimGroup(campId: string): ClaimGroup {
  const fieldRequirements: ClaimRequirement[] = VERIFIED_CAMP_FIELDS.map((field) => ({
    id: field,
    title: VERIFIED_CAMP_FIELD_TITLES[field],
    claimIds: [campCanonicalClaimId(campId, field)],
    required: true,
    severity: 'medium' as ImpactLevel,
  }));

  const sessionsRequirement: ClaimRequirement = {
    id: 'sessions-verified',
    title: 'Sessions verified',
    claimIds: [campSessionsVerifiedClaimId(campId)],
    required: true,
    severity: 'medium' as ImpactLevel,
    metadata: {
      // Documents why this requirement replaces the retired `schedules`
      // field-attestation slot — see this module's header comment.
      replacesRequirement: 'schedules',
    },
  };

  return {
    id: VERIFIED_CAMP_CLAIM_GROUP_ID,
    title: 'Verified Camp Claim Set',
    kind: 'requirement-set',
    description:
      'ADR-0002: a Verified Camp requires verified identity, location, description, ' +
      'classification, and contact-or-registration-path claims, plus a verified Sessions rollup.',
    requirements: [...fieldRequirements, sessionsRequirement],
    rollupPolicy: { mode: 'all-required' },
  };
}

// ---------------------------------------------------------------------------
// Verified Session Claim Set
// ---------------------------------------------------------------------------

/**
 * The 6 Session Attributes decision 4 (session identity + claim set) ratifies
 * — the exact claim-type ids also added to `campfitSessionVocabulary` in
 * `lib/trust-vocabulary.ts`. Order and hyphenation matches
 * docs/contexts/trust-review-provenance/CONTEXT.md's "Verified Session Claim
 * Set" definition verbatim.
 */
export const VERIFIED_SESSION_ATTRIBUTES = [
  'dates',
  'time',
  'eligibility',
  'registration-status',
  'price-options',
  'registration-path',
] as const;

export type VerifiedSessionAttribute = (typeof VERIFIED_SESSION_ATTRIBUTES)[number];

const VERIFIED_SESSION_ATTRIBUTE_TITLES: Record<VerifiedSessionAttribute, string> = {
  dates: 'Session dates',
  time: 'Session time',
  eligibility: 'Eligibility',
  'registration-status': 'Registration status',
  'price-options': 'Price options',
  'registration-path': 'Registration path',
};

/**
 * Attributes inherited-by-design from the parent Camp claim when no
 * per-Session data source exists yet (decision 4's own "explicit Verification
 * Gap for unknowns" language) — `derivedFrom` the Camp-level claim, with
 * `metadata.inherited: 'camp-level'`, per this slice's Wave 3
 * `buildInheritedSessionClaims`. `dates`/`time` are excluded: those get real
 * per-Session evidence from the `schedules` relation-field diff.
 */
export const INHERITED_SESSION_ATTRIBUTES: readonly VerifiedSessionAttribute[] = [
  'eligibility',
  'registration-status',
  'price-options',
  'registration-path',
];

/** Stable id for one Session Attribute's Claim. */
export function sessionClaimId(scheduleId: string, attribute: VerifiedSessionAttribute): string {
  return `session.${scheduleId}.${attribute}`;
}

/** Stable id for the Session's own synthesized rollup Claim (Wave 3 derives its status). */
export function sessionVerifiedClaimId(scheduleId: string): string {
  return `session.${scheduleId}.verified`;
}

export const VERIFIED_SESSION_CLAIM_GROUP_ID = 'verified-session';

/**
 * Builds the Verified Session Claim Set as a `ClaimGroup` scoped to one
 * Session (`CampSchedule` row). Parameterized by `scheduleId` for the same
 * reason `buildVerifiedCampClaimGroup` is parameterized by `campId`.
 */
export function buildVerifiedSessionClaimGroup(scheduleId: string): ClaimGroup {
  const requirements: ClaimRequirement[] = VERIFIED_SESSION_ATTRIBUTES.map((attribute) => ({
    id: attribute,
    title: VERIFIED_SESSION_ATTRIBUTE_TITLES[attribute],
    claimIds: [sessionClaimId(scheduleId, attribute)],
    required: true,
    // V9 fix (MEDIUM, review-code.md): `registration-path` now included in
    // the 'high' branch, matching its own `policy.session.registration-path`
    // VerificationPolicy.impactLevel ('high', below) — the prior ternary
    // left it at the 'medium' default, an unexplained asymmetry between two
    // fields describing the same claim that looked like a copy/paste gap
    // rather than a deliberate choice.
    severity: (attribute === 'registration-status' || attribute === 'price-options' || attribute === 'registration-path'
      ? 'high'
      : 'medium') as ImpactLevel,
    metadata: INHERITED_SESSION_ATTRIBUTES.includes(attribute)
      ? { inheritedByDefault: 'camp-level' }
      : undefined,
  }));

  return {
    id: VERIFIED_SESSION_CLAIM_GROUP_ID,
    title: 'Verified Session Claim Set',
    kind: 'requirement-set',
    description:
      'ADR-0002 / decision 4: a Verified Session requires verified session dates, session time ' +
      '(or an explicit reason time does not apply), eligibility, registration status, price ' +
      'options, and registration path. Unknown registration or price values are an explicit ' +
      'Verification Gap, not a default assumption.',
    requirements,
    rollupPolicy: { mode: 'all-required' },
  };
}

// ---------------------------------------------------------------------------
// VerificationPolicy — one per claim type
// ---------------------------------------------------------------------------

const DURATION_DAYS = {
  campScalarField: 180,
  campRepeatedField: 120,
  sessionDates: 180,
  sessionTime: 180,
  sessionEligibility: 180,
  sessionRegistrationStatus: 30,
  sessionPriceOptions: 90,
  sessionRegistrationPath: 180,
} as const;

function durationValidity(days: number): ValidityRule {
  return { kind: 'duration', durationDays: days };
}

/**
 * One `VerificationPolicy` per distinct `claimType` used by the Verified
 * Camp/Session Claim Sets (`resolvePolicyForClaim` in
 * `node_modules/@kontourai/surface/dist/src/policy-resolver.d.ts` matches a
 * Claim to its policy by `claimType`, so policies are keyed there, not per
 * individual field/attribute). Camp field claims already share 2 claim types
 * in production (`campfitVocabulary.claimTypes.scalarField`/`repeatedField`,
 * `lib/trust-vocabulary.ts`) — this module does not fork that into a
 * per-field claim type. Each of the 6 Session Attributes IS its own claim
 * type (`campfitSessionVocabulary.claimTypes`), so each gets its own policy —
 * ADR-0002 and decision 4 describe genuinely different acceptance criteria
 * per Session Attribute (a date is not verified the same way a price is).
 */
export const VERIFIED_CAMP_SESSION_POLICIES: readonly VerificationPolicy[] = [
  {
    id: 'policy.camp.scalar-field',
    claimType: campfitVocabulary.claimTypes.scalarField,
    requiredEvidence: ['crawl_observation', 'human_attestation'] as EvidenceType[],
    acceptanceCriteria: [
      "Value sourced from a Crawl of the Camp's own Source Page (provider website or " +
        'registration page), or explicitly attested by an Admin (docs/contexts/data-' +
        'stewardship/CONTEXT.md: Crawl, Source Page, Attestation).',
      'An intentionally blank value is acceptable only when explicitly attested as such.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.campScalarField),
    stalenessTriggers: [
      `${DURATION_DAYS.campScalarField} days elapsed since the last verifying event`,
    ],
    conflictRules: [
      'A Parent Correction or a re-Crawl reporting a differing value opens a Conflict ' +
        'requiring Review before the claim can remain verified.',
    ],
    impactLevel: 'medium',
  },
  {
    id: 'policy.camp.repeated-field',
    claimType: campfitVocabulary.claimTypes.repeatedField,
    requiredEvidence: ['crawl_observation', 'human_attestation'] as EvidenceType[],
    acceptanceCriteria: [
      'Every entry in the repeated value (age group, pricing option) is sourced from a Crawl ' +
        'of the Camp\'s own Source Page, or explicitly attested by an Admin.',
      'An empty list is acceptable only when explicitly attested as intentionally empty.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.campRepeatedField),
    stalenessTriggers: [
      `${DURATION_DAYS.campRepeatedField} days elapsed since the last verifying event`,
    ],
    conflictRules: [
      'A Parent Correction or a re-Crawl reporting a differing list opens a Conflict requiring ' +
        'Review before the claim can remain verified.',
    ],
    impactLevel: 'medium',
  },
  {
    id: 'policy.session.dates',
    claimType: campfitSessionVocabulary.claimTypes.dates,
    requiredEvidence: ['crawl_observation', 'human_attestation'] as EvidenceType[],
    acceptanceCriteria: [
      "Session start and end dates are sourced from the provider's own schedule listing " +
        '(matched to this Session by the `schedules` relation-field diff), or explicitly ' +
        'attested by an Admin.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.sessionDates),
    stalenessTriggers: [`${DURATION_DAYS.sessionDates} days elapsed since the last verifying event`],
    conflictRules: [
      'A Parent Correction or re-Crawl reporting different dates for the same Session ' +
        '(same label + date range) opens a Conflict requiring Review.',
    ],
    impactLevel: 'medium',
  },
  {
    id: 'policy.session.time',
    claimType: campfitSessionVocabulary.claimTypes.time,
    requiredEvidence: ['crawl_observation', 'human_attestation'] as EvidenceType[],
    acceptanceCriteria: [
      "Session start and end time are sourced from the provider's own schedule listing, or " +
        'the Session is explicitly attested as having no fixed time ("time does not apply") ' +
        '— decision 4 treats an explicit non-applicability attestation as satisfying this ' +
        'requirement, not as a gap.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.sessionTime),
    stalenessTriggers: [`${DURATION_DAYS.sessionTime} days elapsed since the last verifying event`],
    conflictRules: [
      'A Parent Correction or re-Crawl reporting a different time for the same Session opens ' +
        'a Conflict requiring Review.',
    ],
    impactLevel: 'medium',
  },
  {
    id: 'policy.session.eligibility',
    claimType: campfitSessionVocabulary.claimTypes.eligibility,
    requiredEvidence: ['crawl_observation', 'human_attestation', 'calculation_trace'] as EvidenceType[],
    acceptanceCriteria: [
      'Eligibility (age range or grade band) is verified directly for this Session, or ' +
        "inherited from the Camp's own verified eligibility claim (`ageGroups`) when no " +
        'Session-specific eligibility is tracked yet (decision 4: inherited-by-design, ' +
        "metadata.inherited: 'camp-level').",
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.sessionEligibility),
    stalenessTriggers: [
      `${DURATION_DAYS.sessionEligibility} days elapsed since the last verifying event`,
      "the inherited Camp-level eligibility claim goes stale",
    ],
    conflictRules: [
      'A Session-specific eligibility value that contradicts the inherited Camp-level value ' +
        'opens a Conflict requiring Review before either claim can remain verified.',
    ],
    impactLevel: 'medium',
  },
  {
    id: 'policy.session.registration-status',
    claimType: campfitSessionVocabulary.claimTypes.registrationStatus,
    requiredEvidence: ['crawl_observation', 'human_attestation', 'calculation_trace'] as EvidenceType[],
    acceptanceCriteria: [
      'Registration status (open, waitlist, full, closed) is verified directly for this ' +
        "Session, or inherited from the Camp's own verified registration-status claim when no " +
        'Session-specific status is tracked yet.',
      'An unknown registration status is an explicit Verification Gap (docs/contexts/trust-' +
        'review-provenance/CONTEXT.md), never a default open/closed assumption.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.sessionRegistrationStatus),
    stalenessTriggers: [
      `${DURATION_DAYS.sessionRegistrationStatus} days elapsed since the last verifying event`,
      "the inherited Camp-level registration-status claim goes stale",
    ],
    conflictRules: [
      'A Parent Correction reporting a Session as full while the provider page still shows ' +
        'open (or vice versa) opens a Conflict requiring Review before the claim can remain ' +
        'verified.',
    ],
    impactLevel: 'high',
  },
  {
    id: 'policy.session.price-options',
    claimType: campfitSessionVocabulary.claimTypes.priceOptions,
    requiredEvidence: ['crawl_observation', 'human_attestation', 'calculation_trace'] as EvidenceType[],
    acceptanceCriteria: [
      'Price options are verified directly for this Session (via `CampPricing.scheduleId` ' +
        "once populated), or inherited from the Camp's own verified pricing claim when no " +
        'Session-specific price is recorded.',
      'An unknown price is an explicit Verification Gap, never a default free/paid assumption.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.sessionPriceOptions),
    stalenessTriggers: [
      `${DURATION_DAYS.sessionPriceOptions} days elapsed since the last verifying event`,
      "the inherited Camp-level pricing claim goes stale",
    ],
    conflictRules: [
      'A Parent Correction or re-Crawl reporting a different price for the same Session opens ' +
        'a Conflict requiring Review before the claim can remain verified.',
    ],
    impactLevel: 'high',
  },
  {
    id: 'policy.session.registration-path',
    claimType: campfitSessionVocabulary.claimTypes.registrationPath,
    requiredEvidence: ['crawl_observation', 'human_attestation', 'calculation_trace'] as EvidenceType[],
    acceptanceCriteria: [
      'The registration path (URL or contact) is verified directly for this Session, or ' +
        "inherited from the Camp's own verified registration-path claim (`websiteUrl`/" +
        '`registrationStatus`) when no Session-specific path is tracked.',
    ],
    reviewAuthority: 'campfit-admin',
    validityRule: durationValidity(DURATION_DAYS.sessionRegistrationPath),
    stalenessTriggers: [
      `${DURATION_DAYS.sessionRegistrationPath} days elapsed since the last verifying event`,
      "the inherited Camp-level registration-path claim goes stale",
    ],
    conflictRules: [
      'A Session-specific registration path that contradicts the inherited Camp-level path ' +
        'opens a Conflict requiring Review before either claim can remain verified.',
    ],
    impactLevel: 'high',
  },
];

// ---------------------------------------------------------------------------
// TrustStatus -> DataConfidence projection
// ---------------------------------------------------------------------------

/**
 * Projects a Surface `TrustStatus` (docs/contexts/trust-review-provenance/
 * CONTEXT.md: "Verification Status") down to CampFit's existing 3-valued
 * `Camp.dataConfidence` column (`VERIFIED | PLACEHOLDER | STALE`,
 * `prisma/migrations/001_initial_schema.sql`).
 *
 * `verified -> VERIFIED`; `stale -> STALE`; every other status (`unknown`,
 * `proposed`, `assumed`, `disputed`, `superseded`, `rejected`, `revoked`) ->
 * `PLACEHOLDER` — the existing "not yet ready for parents" bucket, which is
 * also `Camp.dataConfidence`'s column `DEFAULT`, so a brand-new Camp with no
 * Claims at all still lands on `PLACEHOLDER` exactly as it does today. This
 * mapping is deliberately CampFit-local/product-specific (see this slice's
 * plan, "Upstream opportunities" #4) — it collapses Surface's general
 * 9-valued vocabulary into CampFit's own 3-valued one, which is not a
 * generic capability to upstream.
 */
export function projectTrustStatusToDataConfidence(status: TrustStatus): DataConfidence {
  switch (status) {
    case 'verified':
      return 'VERIFIED';
    case 'stale':
      return 'STALE';
    default:
      return 'PLACEHOLDER';
  }
}
