/**
 * Field-level verification coverage for the VERIFIED badge.
 *
 * VERIFIED means: every required field that has a value on the camp record
 * has been explicitly approved from a source — either a crawl excerpt or
 * admin review — documented in fieldSources[field].approvedAt.
 *
 * Optional fields (not blocking VERIFIED): neighborhood, address,
 * lunchIncluded, interestingDetails, registrationOpenDate.
 *
 * Relation fields (ageGroups, pricing, schedules) count only if the
 * array is non-empty — an empty array means "we just don't have data yet."
 */

import type { Camp, FieldSource } from '@/lib/types';

/** Fields required to be sourced before VERIFIED status can be set. */
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
  covered: RequiredField[];   // required fields with approved fieldSources
  missing: RequiredField[];   // required fields present but lacking a source
  skipped: RequiredField[];   // required fields that are empty/null (not blocking)
  pct: number;                // covered / (covered + missing) * 100, NaN if nothing to verify
}

/**
 * Compute field-level verification coverage for a camp.
 *
 * @param camp - the camp record (may omit fieldSources, relations)
 * @param fieldSources - the camp's fieldSources map (separate so callers can pass subsets)
 */
export function computeCoverage(
  camp: Partial<Camp>,
  fieldSources: Record<string, FieldSource> | null | undefined
): CoverageResult {
  const sources = fieldSources ?? {};
  const covered: RequiredField[] = [];
  const missing: RequiredField[] = [];
  const skipped: RequiredField[] = [];

  for (const field of REQUIRED_FOR_VERIFIED) {
    const value = (camp as Record<string, unknown>)[field];
    const isEmpty = isEmptyValue(value);

    if (isEmpty) {
      skipped.push(field);
      continue;
    }

    if (sources[field]?.approvedAt) {
      covered.push(field);
    } else {
      missing.push(field);
    }
  }

  const total = covered.length + missing.length;
  const pct = total === 0 ? 100 : Math.round((covered.length / total) * 100);

  return { covered, missing, skipped, pct };
}

/**
 * Returns true if all required non-empty fields have source citations.
 * This is the gate for auto-setting dataConfidence = 'VERIFIED'.
 */
export function isFullyVerified(
  camp: Partial<Camp>,
  fieldSources: Record<string, FieldSource> | null | undefined
): boolean {
  const { missing } = computeCoverage(camp, fieldSources);
  return missing.length === 0;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}
