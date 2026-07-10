import type { Camp } from '@/lib/types';
import type { CampInput } from './adapter';
import type { ProposedChanges, FieldDiff } from '@/lib/admin/types';
import {
  changeWhenDifferent,
  outerArrayChange,
  projectProvenance,
  relationDomainIdentity,
  relationFacts,
  scalarChange,
} from './diff-kernel';

const MIN_CONFIDENCE = 0.3; // Skip fields below this threshold
const SUPPRESS_DAYS = 30;  // Re-suppress recently-approved fields at low confidence
const SUPPRESS_CONFIDENCE = 0.8; // Threshold below which suppression applies

const SCALAR_FIELDS = [
  'name', 'organizationName', 'description', 'registrationStatus',
  'registrationOpenDate', 'registrationCloseDate', 'lunchIncluded', 'address', 'neighborhood',
  'city', 'websiteUrl', 'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
  'interestingDetails', 'state', 'zip',
] as const;

const ARRAY_FIELDS = ['ageGroups', 'schedules', 'pricing'] as const;

const ENUM_ARRAY_FIELDS = ['campTypes', 'categories'] as const;

export function computeDiff(
  current: Camp,
  extracted: Partial<CampInput>,
  confidence: Record<string, number>,
  excerpts: Record<string, string> = {},
  fieldSources: Record<string, { approvedAt?: string }> = {},
  sourceUrl = ''
): ProposedChanges {
  const changes: ProposedChanges = {};
  const now = Date.now();

  // Scalar fields
  for (const field of SCALAR_FIELDS) {
    const conf = confidence[field] ?? 0;
    if (conf < MIN_CONFIDENCE) continue;

    const extractedVal = (extracted as Record<string, unknown>)[field];
    if (extractedVal === undefined || extractedVal === null) continue;

    const currentVal = (current as unknown as Record<string, unknown>)[field];

    const change = scalarChange(currentVal, extractedVal);
    if (change) {
      // Suppress re-proposals for recently-approved fields at low confidence
      const src = fieldSources[field];
      if (src?.approvedAt) {
        const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
        if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
      }

      const isEmpty = currentVal === null || currentVal === undefined || currentVal === '';
      changes[field] = {
        ...change,
        confidence: conf,
        mode: isEmpty ? 'populate' : 'update',
        ...projectProvenance({ excerpt: excerpts[field], sourceUrl }),
      };
    }
  }

  // Enum array fields (campTypes, categories) — support string or array from LLM
  for (const field of ENUM_ARRAY_FIELDS) {
    const conf = confidence[field] ?? 0;
    if (conf < MIN_CONFIDENCE) continue;

    let extractedVal = (extracted as Record<string, unknown>)[field];
    if (extractedVal === undefined || extractedVal === null) continue;

    // If LLM returned a single string, wrap in array
    if (typeof extractedVal === 'string') extractedVal = [extractedVal];
    if (!Array.isArray(extractedVal) || extractedVal.length === 0) continue;

    const currentArr = (current as unknown as Record<string, unknown>)[field];
    const currentItems = Array.isArray(currentArr) ? currentArr : [];

    const sortedCurrent = [...currentItems].sort().join(',');
    const sortedExtracted = [...(extractedVal as unknown[])].sort().join(',');

    const change = changeWhenDifferent(
      currentItems,
      extractedVal,
      () => sortedCurrent === sortedExtracted
    );
    if (change) {
      const src = fieldSources[field];
      if (src?.approvedAt) {
        const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
        if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
      }

      const isEmpty = currentItems.length === 0;
      changes[field] = {
        ...change,
        confidence: conf,
        mode: isEmpty ? 'populate' : 'update',
        ...projectProvenance({ excerpt: excerpts[field], sourceUrl }),
      };
    }
  }

  // Array fields — detect full replace vs additive
  for (const field of ARRAY_FIELDS) {
    const conf = confidence[field] ?? 0;
    if (conf < MIN_CONFIDENCE) continue;

    const extractedArr = (extracted as Record<string, unknown>)[field];
    if (!Array.isArray(extractedArr) || extractedArr.length === 0) continue;

    const currentArr = (current as unknown as Record<string, unknown>)[field];
    const currentItems = Array.isArray(currentArr) ? currentArr : [];
    const identity = relationDomainIdentity(field);

    const change = outerArrayChange(currentItems, extractedArr, identity);
    if (change) {
      // Suppress recently-approved array fields too
      const src = fieldSources[field];
      if (src?.approvedAt) {
        const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
        if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
      }

      // Check if extracted is purely additive (all current items still present)
      const { allCurrentRetained, hasNovelCandidate } = relationFacts(currentItems, extractedArr, identity);
      const isAdditive = currentItems.length > 0 &&
        allCurrentRetained &&
        extractedArr.length > currentItems.length &&
        hasNovelCandidate;

      changes[field] = {
        ...change,
        confidence: conf,
        mode: currentItems.length === 0 ? 'populate' : isAdditive ? 'add_items' : 'update',
        ...projectProvenance({ excerpt: excerpts[field], sourceUrl }),
      };
    }
  }

  return changes;
}

export function computeOverallConfidence(proposedChanges: ProposedChanges): number {
  const diffs = Object.values(proposedChanges) as FieldDiff[];
  if (diffs.length === 0) return 0;
  const avg = diffs.reduce((sum, d) => sum + d.confidence, 0) / diffs.length;
  return Math.round(avg * 100) / 100;
}
