/**
 * Field-level verification coverage for the VERIFIED badge.
 *
 * VERIFIED means: every required field has been explicitly attested by an
 * admin or sourced from a crawl — documented in fieldSources[field].approvedAt.
 *
 * A blank/null field is acceptable IF an admin has explicitly attested it
 * (i.e. fieldSources[field] exists with approvedAt). This signals "I checked
 * and this is intentionally N/A for this camp."
 *
 * Fields that are blank AND have no attestation block VERIFIED — an admin
 * must either populate the field via a crawl proposal OR explicitly attest it.
 */

import type { Camp, FieldSource } from '@/lib/types';

/** Fields required to be attested before VERIFIED status can be set. */
export const REQUIRED_FOR_VERIFIED = [
  'description',
  'campType',
  'category',
  'registrationStatus',
  'city',
  'websiteUrl',
  'ageGroups',
  'pricing',
  'schedules',
] as const;

export type RequiredField = typeof REQUIRED_FOR_VERIFIED[number];

export interface CoverageResult {
  covered: RequiredField[];    // attested (has fieldSources[f].approvedAt) — may be blank
  missing: RequiredField[];    // has a value but no attestation yet
  unattested: RequiredField[]; // blank/null AND no attestation — needs explicit "N/A" or data
  pct: number;                 // covered / total * 100
}

/**
 * Compute field-level verification coverage for a camp.
 * Every required field must have fieldSources[field].approvedAt to count as covered,
 * regardless of whether the field value itself is empty.
 */
export function computeCoverage(
  camp: Partial<Camp>,
  fieldSources: Record<string, FieldSource> | null | undefined
): CoverageResult {
  const sources = fieldSources ?? {};
  const covered: RequiredField[] = [];
  const missing: RequiredField[] = [];
  const unattested: RequiredField[] = [];

  for (const field of REQUIRED_FOR_VERIFIED) {
    const attested = !!sources[field]?.approvedAt;
    if (attested) {
      covered.push(field);
    } else {
      const value = (camp as Record<string, unknown>)[field];
      if (isEmptyValue(value)) {
        unattested.push(field); // blank + no attestation — needs admin "N/A" or data
      } else {
        missing.push(field);    // has value but no source — needs proposal approval
      }
    }
  }

  const total = REQUIRED_FOR_VERIFIED.length;
  const pct = Math.round((covered.length / total) * 100);

  return { covered, missing, unattested, pct };
}

/**
 * Returns true only when ALL required fields have attestations.
 */
export function isFullyVerified(
  camp: Partial<Camp>,
  fieldSources: Record<string, FieldSource> | null | undefined
): boolean {
  const { missing, unattested } = computeCoverage(camp, fieldSources);
  return missing.length === 0 && unattested.length === 0;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}
