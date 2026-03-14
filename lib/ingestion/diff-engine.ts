import type { Camp } from '@/lib/types';
import type { CampInput } from './adapter';
import type { ProposedChanges, FieldDiff } from '@/lib/admin/types';

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

    if (normalize(currentVal) !== normalize(extractedVal)) {
      // Suppress re-proposals for recently-approved fields at low confidence
      const src = fieldSources[field];
      if (src?.approvedAt) {
        const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
        if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
      }

      const isEmpty = currentVal === null || currentVal === undefined || currentVal === '';
      changes[field] = {
        old: currentVal,
        new: extractedVal,
        confidence: conf,
        mode: isEmpty ? 'populate' : 'update',
        ...(excerpts[field] ? { excerpt: excerpts[field] } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
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

    if (sortedCurrent !== sortedExtracted) {
      const src = fieldSources[field];
      if (src?.approvedAt) {
        const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
        if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
      }

      const isEmpty = currentItems.length === 0;
      changes[field] = {
        old: currentItems,
        new: extractedVal,
        confidence: conf,
        mode: isEmpty ? 'populate' : 'update',
        ...(excerpts[field] ? { excerpt: excerpts[field] } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
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

    if (stableJson(currentItems) !== stableJson(extractedArr)) {
      // Suppress recently-approved array fields too
      const src = fieldSources[field];
      if (src?.approvedAt) {
        const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
        if (daysSince < SUPPRESS_DAYS && conf < SUPPRESS_CONFIDENCE) continue;
      }

      // Check if extracted is purely additive (all current items still present)
      const currentSet = new Set(currentItems.map(i => stableJson(i)));
      const isAdditive = currentItems.length > 0 &&
        extractedArr.every((item: unknown) => currentSet.has(stableJson(item)) || !currentSet.has(stableJson(item))) &&
        extractedArr.length > currentItems.length &&
        currentItems.every((item: unknown) => new Set(extractedArr.map((i: unknown) => stableJson(i))).has(stableJson(item)));

      changes[field] = {
        old: currentItems,
        new: extractedArr,
        confidence: conf,
        mode: currentItems.length === 0 ? 'populate' : isAdditive ? 'add_items' : 'update',
        ...(excerpts[field] ? { excerpt: excerpts[field] } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
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
  if (typeof val === 'object') return stableObjectString(val);
  return String(val).trim().toLowerCase();
}

function stableObjectString(val: unknown): string {
  if (Array.isArray(val)) return stableJson(val);
  if (!val || typeof val !== 'object') return String(val ?? '');
  const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

function stableJson(val: unknown): string {
  if (!Array.isArray(val)) return JSON.stringify(val);
  // Sort arrays by JSON stringification for stable comparison
  const sorted = [...val].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
  return JSON.stringify(sorted);
}
