import type { Camp } from '@/lib/types';
import type { CampInput } from './adapter';
import type { ProposedChanges, FieldDiff } from '@/lib/admin/types';

const MIN_CONFIDENCE = 0.3; // Skip fields below this threshold

const SCALAR_FIELDS = [
  'name', 'description', 'campType', 'category', 'registrationStatus',
  'registrationOpenDate', 'lunchIncluded', 'address', 'neighborhood',
  'city', 'websiteUrl', 'interestingDetails',
] as const;

const ARRAY_FIELDS = ['ageGroups', 'schedules', 'pricing'] as const;

export function computeDiff(
  current: Camp,
  extracted: Partial<CampInput>,
  confidence: Record<string, number>
): ProposedChanges {
  const changes: ProposedChanges = {};

  // Scalar fields
  for (const field of SCALAR_FIELDS) {
    const conf = confidence[field] ?? 0;
    if (conf < MIN_CONFIDENCE) continue;

    const extractedVal = (extracted as Record<string, unknown>)[field];
    if (extractedVal === undefined || extractedVal === null) continue;

    const currentVal = (current as unknown as Record<string, unknown>)[field];

    // Normalize for comparison
    const normalizedCurrent = normalize(currentVal);
    const normalizedExtracted = normalize(extractedVal);

    if (normalizedCurrent !== normalizedExtracted) {
      changes[field] = {
        old: currentVal,
        new: extractedVal,
        confidence: conf,
      };
    }
  }

  // Array fields — compare as sorted normalized JSON
  for (const field of ARRAY_FIELDS) {
    const conf = confidence[field] ?? 0;
    if (conf < MIN_CONFIDENCE) continue;

    const extractedArr = (extracted as Record<string, unknown>)[field];
    if (!Array.isArray(extractedArr) || extractedArr.length === 0) continue;

    const currentArr = (current as unknown as Record<string, unknown>)[field];
    const currentJson = stableJson(currentArr);
    const extractedJson = stableJson(extractedArr);

    if (currentJson !== extractedJson) {
      changes[field] = {
        old: currentArr,
        new: extractedArr,
        confidence: conf,
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

function normalize(val: unknown): string {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') return String(val);
  return String(val).trim().toLowerCase();
}

function stableJson(val: unknown): string {
  if (!Array.isArray(val)) return JSON.stringify(val);
  // Sort arrays by JSON stringification for stable comparison
  const sorted = [...val].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
  return JSON.stringify(sorted);
}
