export const CAMPFIT_TRUST_SUBJECT_TYPE = 'public-directory.camp';
export const CAMPFIT_TRUST_SURFACE = 'public-directory.camp-profile';

export const CAMPFIT_CLAIM_TYPES = {
  scalarField: 'public-data.field',
  scalarFieldCandidate: 'public-data.field-candidate',
  repeatedField: 'public-data.repeated-field',
  repeatedFieldCandidate: 'public-data.repeated-field-candidate',
} as const;

export const CAMPFIT_DECISION_EFFECTS = {
  acceptedCandidateValue: 'accepted-candidate-value',
  keptCurrentValue: 'kept-current-value',
  manualAssumption: 'manual-assumption',
} as const;

export type CampfitScalarClaimType =
  | typeof CAMPFIT_CLAIM_TYPES.scalarField
  | typeof CAMPFIT_CLAIM_TYPES.scalarFieldCandidate;

export type CampfitRepeatedClaimType =
  | typeof CAMPFIT_CLAIM_TYPES.repeatedField
  | typeof CAMPFIT_CLAIM_TYPES.repeatedFieldCandidate;

export type CampfitDecisionEffect =
  typeof CAMPFIT_DECISION_EFFECTS[keyof typeof CAMPFIT_DECISION_EFFECTS];
