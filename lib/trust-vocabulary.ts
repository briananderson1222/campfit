import { defineProductVocabulary } from '@kontourai/survey';

// CampFit's Survey/Surface vocabulary. Previously a set of loose top-level
// string constants; now a single discoverable, deep-frozen vocabulary via
// Survey's defineProductVocabulary. The helper's
// type parameters carry the `const` modifier (TS 5.0+, campfit is on 6.0.3),
// so claimTypes/decisionEffects keep their string-literal types with no
// `as const` needed at this call site.
export const campfitVocabulary = defineProductVocabulary({
  subjectType: 'public-directory.camp',
  surface: 'public-directory.camp-profile',
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
