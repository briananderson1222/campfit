import { defineProductVocabulary } from '@kontourai/survey';

// CampFit's Survey/Surface vocabulary. Previously a set of loose top-level
// string constants; now a single discoverable, deep-frozen vocabulary via
// Survey's defineProductVocabulary. The helper's
// type parameters carry the `const` modifier (TS 5.0+, campfit is on 6.0.3),
// so claimTypes/decisionEffects keep their string-literal types with no
// `as const` needed at this call site.
export const campfitVocabulary = defineProductVocabulary({
  subjectType: 'public-directory.camp',
  facet: 'public-directory.camp-profile',
  claimTypes: {
    scalarField: 'public-data.field',
    scalarFieldCandidate: 'public-data.field-candidate',
    repeatedField: 'public-data.repeated-field',
    repeatedFieldCandidate: 'public-data.repeated-field-candidate',
  },
  decisionEffects: {
    acceptedCandidateValue: 'accepted-candidate-value',
    keptCurrentValue: 'kept-current-value',
    manualAssumption: 'manual-assumption',
  },
});

export type CampfitScalarClaimType =
  | typeof campfitVocabulary.claimTypes.scalarField
  | typeof campfitVocabulary.claimTypes.scalarFieldCandidate;

export type CampfitRepeatedClaimType =
  | typeof campfitVocabulary.claimTypes.repeatedField
  | typeof campfitVocabulary.claimTypes.repeatedFieldCandidate;

export type CampfitDecisionEffect =
  (typeof campfitVocabulary.decisionEffects)[keyof typeof campfitVocabulary.decisionEffects];

// CampFit's Session vocabulary — additive sibling to `campfitVocabulary` above.
// `defineProductVocabulary` fixes exactly one `subjectType`/`facet` pair per
// call, so the Verified Session Claim Set (docs/contexts/trust-review-
// provenance/CONTEXT.md: "session dates, session time or a clear reason time
// does not apply, eligibility, registration status, price options, and
// registration path") gets its own vocabulary value rather than a second
// subjectType bolted onto `campfitVocabulary`'s single-subject shape. Each
// Session (`CampSchedule` row) is its own claim Subject
// (`public-directory.camp-session`), distinct from its parent Camp Subject.
// Reuses `campfitVocabulary.decisionEffects` as-is (Review resolves a
// session-level Proposed Value exactly the same way it resolves a Camp-level
// one) — does not touch or redefine `campfitVocabulary`'s existing
// `scalarField`/`repeatedField`/decisionEffects entries.
export const campfitSessionVocabulary = defineProductVocabulary({
  subjectType: 'public-directory.camp-session',
  facet: 'public-directory.camp-session-profile',
  claimTypes: {
    dates: 'public-data.session-dates',
    time: 'public-data.session-time',
    eligibility: 'public-data.session-eligibility',
    registrationStatus: 'public-data.session-registration-status',
    priceOptions: 'public-data.session-price-options',
    registrationPath: 'public-data.session-registration-path',
  },
  decisionEffects: campfitVocabulary.decisionEffects,
});

export type CampfitSessionClaimType =
  (typeof campfitSessionVocabulary.claimTypes)[keyof typeof campfitSessionVocabulary.claimTypes];
