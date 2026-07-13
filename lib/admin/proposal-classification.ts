import type { FieldDiff, ProposedChanges } from './types';

/** A populate claim fills an absent value; it is not a diff against an
 * existing Camp value and therefore is never safe for batch selection. */
export function isPopulateFieldClaim(diff: FieldDiff | undefined): boolean {
  return diff?.mode === 'populate' || diff?.old == null;
}

/** Fresh-discovery proposals describe a wholly new Camp: every proposed
 * field populates an absent value. Empty proposals are not fresh discovery. */
export function isFreshDiscoveryProposal(proposedChanges: ProposedChanges): boolean {
  const diffs = Object.values(proposedChanges);
  return diffs.length > 0 && diffs.every(isPopulateFieldClaim);
}

/** Batch eligibility requires both independent exact corroboration and a
 * real current-to-proposed diff. */
export function isBatchSelectableFieldClaim(diff: FieldDiff | undefined, exact: boolean): boolean {
  return exact && !isPopulateFieldClaim(diff);
}

export function proposedCampName(proposedChanges: ProposedChanges, fallback?: string): string {
  const proposedName = proposedChanges.name?.new;
  return typeof proposedName === 'string' && proposedName.trim().length > 0
    ? proposedName.trim()
    : (fallback?.trim() || 'Unnamed camp');
}
