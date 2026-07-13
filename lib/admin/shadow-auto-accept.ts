import { CAMP_RELATION_TABLES, CAMP_SCALAR_FIELDS } from './proposal-fields';
import type { ProposedChanges } from './types';

export type ShadowAutoAcceptFieldClass = 'low-risk' | 'high-risk';

export interface ShadowAutoAcceptConfig {
  readonly threshold?: number;
  readonly lowRiskFields?: readonly string[];
  readonly highRiskFields?: readonly string[];
}

export interface ResolvedShadowAutoAcceptConfig {
  readonly threshold: number;
  readonly lowRiskFields: readonly string[];
  readonly highRiskFields: readonly string[];
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
}

/**
 * Narrow shadow allowlist:
 * - organizationName identifies the operator without changing camp identity.
 * - description is explanatory prose.
 * - campType and category are descriptive taxonomy.
 * - ageGroups describe audience eligibility without changing dated sessions.
 * - city is coarse discovery geography, not a destination address.
 */
export const LOW_RISK_FIELDS: readonly string[] = [
  'organizationName',
  'description',
  'campType',
  'category',
  'ageGroups',
  'city',
];

/**
 * Operational fields whose error could change cost, timing, registration,
 * destination/contact details, or where a family physically goes. They never
 * shadow-pass, regardless of confidence.
 */
const KNOWN_PROPOSAL_FIELDS = [
  ...CAMP_SCALAR_FIELDS,
  ...Object.keys(CAMP_RELATION_TABLES),
] as const;

// Derived from the complete Review Apply allowlists so a newly introduced
// writable field defaults to high-risk until it is deliberately promoted.
export const HIGH_RISK_FIELDS: readonly string[] = KNOWN_PROPOSAL_FIELDS
  .filter((field) => !LOW_RISK_FIELDS.includes(field));

export const DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG: ResolvedShadowAutoAcceptConfig = Object.freeze({
  threshold: 0.9,
  lowRiskFields: Object.freeze([...LOW_RISK_FIELDS]),
  highRiskFields: Object.freeze([...HIGH_RISK_FIELDS]),
  valid: true,
  invalidReasons: Object.freeze([]),
});

function resolveConfig(config: ShadowAutoAcceptConfig = {}): ResolvedShadowAutoAcceptConfig {
  const invalidReasons: string[] = [];
  const configValid = config !== null && typeof config === 'object' && !Array.isArray(config);
  if (!configValid) invalidReasons.push('config must be an object');
  const supplied: ShadowAutoAcceptConfig = configValid ? config : {};
  const requestedThreshold = supplied.threshold === undefined
    ? DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG.threshold
    : supplied.threshold;
  const thresholdValid = typeof requestedThreshold === 'number'
    && Number.isFinite(requestedThreshold)
    && requestedThreshold >= 0
    && requestedThreshold <= 1;
  if (!thresholdValid) invalidReasons.push('threshold must be a finite number between 0 and 1');

  const requestedLow = supplied.lowRiskFields === undefined
    ? DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG.lowRiskFields
    : supplied.lowRiskFields;
  const requestedHigh = supplied.highRiskFields === undefined ? [] : supplied.highRiskFields;
  const validFieldList = (value: unknown): value is readonly string[] => Array.isArray(value)
    && value.every((field) => typeof field === 'string' && field.length > 0);
  if (!validFieldList(requestedLow)) invalidReasons.push('lowRiskFields must be a list of non-empty field names');
  if (!validFieldList(requestedHigh)) invalidReasons.push('highRiskFields must be a list of non-empty field names');

  const defaultLow = new Set(DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG.lowRiskFields);
  const safeRequestedLow = validFieldList(requestedLow) ? requestedLow : [];
  const wideningFields = safeRequestedLow.filter((field) => !defaultLow.has(field));
  if (wideningFields.length > 0) {
    invalidReasons.push(`lowRiskFields cannot promote default high-risk fields: ${wideningFields.join(', ')}`);
  }
  const highRiskFields = new Set(DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG.highRiskFields);
  if (validFieldList(requestedHigh)) requestedHigh.forEach((field) => highRiskFields.add(field));
  const lowRiskFields = safeRequestedLow.filter((field) => defaultLow.has(field) && !highRiskFields.has(field));

  return {
    threshold: thresholdValid ? requestedThreshold : DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG.threshold,
    lowRiskFields,
    highRiskFields: [...highRiskFields],
    valid: invalidReasons.length === 0,
    invalidReasons,
  };
}

export function evaluateShadowAutoAccept(
  input: {
    readonly overallConfidence: number | null;
    readonly proposedChanges: ProposedChanges;
    readonly snapshotResolved: boolean;
  },
  config?: ShadowAutoAcceptConfig,
): {
  wouldAutoAccept: boolean;
  perField: Array<{ field: string; class: ShadowAutoAcceptFieldClass; pass: boolean; reasons: string[] }>;
  config: ResolvedShadowAutoAcceptConfig;
} {
  const resolvedConfig = resolveConfig(config);
  const confidencePass = typeof input.overallConfidence === 'number'
    && Number.isFinite(input.overallConfidence)
    && input.overallConfidence >= resolvedConfig.threshold;
  const lowRisk = new Set(resolvedConfig.lowRiskFields);
  const explicitlyHighRisk = new Set(resolvedConfig.highRiskFields);

  const perField = Object.keys(input.proposedChanges).sort().map((field) => {
    const isLowRisk = lowRisk.has(field) && !explicitlyHighRisk.has(field);
    const reasons: string[] = [];
    if (isLowRisk) reasons.push('field is in the low-risk allowlist');
    else if (explicitlyHighRisk.has(field)) reasons.push('field is high-risk and requires human review');
    else reasons.push('field is unknown and is treated as high-risk');
    if (!confidencePass) reasons.push('overall confidence is below the configured threshold or missing');
    if (!input.snapshotResolved) reasons.push('snapshot evidence is missing or unresolved');
    if (!resolvedConfig.valid) reasons.push(...resolvedConfig.invalidReasons.map((reason) => `invalid config: ${reason}`));
    return {
      field,
      class: isLowRisk ? 'low-risk' as const : 'high-risk' as const,
      pass: resolvedConfig.valid && isLowRisk && confidencePass && input.snapshotResolved,
      reasons,
    };
  });

  return {
    wouldAutoAccept: perField.length > 0 && perField.every((field) => field.pass),
    perField,
    config: resolvedConfig,
  };
}
