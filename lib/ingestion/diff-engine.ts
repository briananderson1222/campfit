import type { Camp } from '@/lib/types';
import type { CampInput } from './adapter';
import type { ProposedChanges, FieldDiff } from '@/lib/admin/types';
import {
  projectProvenance,
  projectScheduleDomain,
  relationDomainIdentity,
  normalizeScalar,
} from './diff-policy';
import { plainLabel } from './plain-label';
import { compareRelation, compareValue } from './lookout-diff-adapter';

// A change to a field a reviewer approved within this window is still
// emitted, flagged `contradictsRecentApproval`, so the queue can order or
// group it. The extractor's self-reported confidence never decides whether a
// detected change reaches review: it is carried on the diff for ranking only.
const RECENT_APPROVAL_DAYS = 30;

/** Self-reported confidence for a field, or undefined when none was reported. */
function knownConfidence(confidence: Record<string, number>, field: string): number | undefined {
  const value = confidence[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Review signals shared by every emitted diff: the confidence when one was
 * reported (absent means unknown, not 0), and the recent-approval flag when
 * the change contradicts a value approved within RECENT_APPROVAL_DAYS.
 */
function reviewSignals(
  conf: number | undefined,
  src: { approvedAt?: string } | undefined,
  now: number,
): Pick<FieldDiff, 'confidence' | 'contradictsRecentApproval' | 'recentApprovalAt'> {
  const signals: Pick<FieldDiff, 'confidence' | 'contradictsRecentApproval' | 'recentApprovalAt'> = {};
  if (conf !== undefined) signals.confidence = conf;
  if (src?.approvedAt) {
    const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
    if (daysSince < RECENT_APPROVAL_DAYS) {
      signals.contradictsRecentApproval = true;
      signals.recentApprovalAt = src.approvedAt;
    }
  }
  return signals;
}

const SCALAR_FIELDS = [
  'name', 'organizationName', 'description', 'registrationStatus',
  'registrationOpenDate', 'registrationCloseDate', 'lunchIncluded', 'address', 'neighborhood',
  'city', 'websiteUrl', 'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
  'interestingDetails', 'state', 'zip',
] as const;

const ARRAY_FIELDS = ['ageGroups', 'schedules', 'pricing'] as const;

const ENUM_ARRAY_FIELDS = ['campTypes', 'categories'] as const;

/**
 * A page that does not state a session's time is not evidence the time was
 * removed, and approving a session list writes every row's time. So a crawled
 * session with no time that is the same session as a stored one (same plain
 * label and dates, and the only stored session with them) keeps the stored
 * time, as the socialLinks merge below keeps unlinked profiles. A crawled
 * time that differs from the stored one is a change, proposed for review like
 * any other. The kept time carries no citation, so an approval does not
 * attest it again: whoever attested it before (a reviewer, a steward) still
 * stands, because the value did not change.
 */
export function keepUnstatedSessionTimes(currentItems: readonly unknown[], extractedRows: readonly unknown[]): unknown[] {
  const keyOf = (row: unknown): string => {
    const domain = projectScheduleDomain(row);
    return `${plainLabel(domain.label ?? '').toLowerCase()}|${domain.startDate ?? ''}|${domain.endDate ?? ''}`;
  };
  const stored = new Map<string, Record<string, unknown>[]>();
  for (const row of currentItems) {
    if (!isPlainObject(row)) continue;
    const key = keyOf(row);
    stored.set(key, [...(stored.get(key) ?? []), row]);
  }
  return extractedRows.map((row) => {
    if (!isPlainObject(row) || row.startTime != null || row.endTime != null) return row;
    const matches = stored.get(keyOf(row)) ?? [];
    const only = matches.length === 1 ? matches[0]! : null;
    if (!only || typeof only.startTime !== 'string' || typeof only.endTime !== 'string' || !only.startTime.trim() || !only.endTime.trim()) return row;
    return { ...row, startTime: only.startTime, endTime: only.endTime };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function computeDiff(
  current: Camp,
  extracted: Partial<CampInput>,
  confidence: Record<string, number>,
  excerpts: Record<string, string> = {},
  fieldSources: Record<string, { approvedAt?: string }> = {},
  sourceUrl = '',
  locators: Record<string, string> = {},
  rowCitations: Record<string, { excerpt: string; locator?: string }[]> = {},
): ProposedChanges {
  const changes: ProposedChanges = {};
  const now = Date.now();

  // Scalar fields
  for (const field of SCALAR_FIELDS) {
    const conf = knownConfidence(confidence, field);

    let extractedVal = (extracted as Record<string, unknown>)[field];
    if (extractedVal === undefined || extractedVal === null) continue;

    const currentVal = (current as unknown as Record<string, unknown>)[field];
    // A page that links only some of a camp's profiles is not evidence the
    // others were removed, and approving replaces the stored object. Extracted
    // links are therefore merged over the current ones, never substituted.
    if (field === 'socialLinks' && isPlainObject(extractedVal) && isPlainObject(currentVal)) {
      extractedVal = { ...currentVal, ...extractedVal };
    }

    const comparison = compareValue(currentVal, extractedVal, normalizeScalar);
    if (comparison.changed && comparison.change) {
      const isEmpty = currentVal === null || currentVal === undefined || currentVal === '';
      changes[field] = {
        ...comparison.change,
        ...reviewSignals(conf, fieldSources[field], now),
        mode: isEmpty ? 'populate' : 'update',
        ...projectProvenance({ excerpt: excerpts[field], sourceUrl, locator: locators[field] }),
      };
    }
  }

  // Enum array fields (campTypes, categories) — support string or array from LLM
  for (const field of ENUM_ARRAY_FIELDS) {
    const conf = knownConfidence(confidence, field);

    let extractedVal = (extracted as Record<string, unknown>)[field];
    if (extractedVal === undefined || extractedVal === null) continue;

    // If LLM returned a single string, wrap in array
    if (typeof extractedVal === 'string') extractedVal = [extractedVal];
    if (!Array.isArray(extractedVal) || extractedVal.length === 0) continue;

    const currentArr = (current as unknown as Record<string, unknown>)[field];
    const currentItems = Array.isArray(currentArr) ? currentArr : [];

    const comparison = compareValue(currentItems, extractedVal, normalizeScalar);
    if (comparison.changed && comparison.change) {
      const isEmpty = currentItems.length === 0;
      changes[field] = {
        ...comparison.change,
        ...reviewSignals(conf, fieldSources[field], now),
        mode: isEmpty ? 'populate' : 'update',
        ...projectProvenance({ excerpt: excerpts[field], sourceUrl, locator: locators[field] }),
        ...(rowCitations[field] ? { rowCitations: rowCitations[field] } : {}),
      };
    }
  }

  // Array fields — detect full replace vs additive
  for (const field of ARRAY_FIELDS) {
    const conf = knownConfidence(confidence, field);

    const extractedValue = (extracted as Record<string, unknown>)[field];
    if (!Array.isArray(extractedValue) || extractedValue.length === 0) continue;

    const currentArr = (current as unknown as Record<string, unknown>)[field];
    const currentItems = Array.isArray(currentArr) ? currentArr : [];
    const extractedArr = field === 'schedules' ? keepUnstatedSessionTimes(currentItems, extractedValue) : extractedValue;
    const identity = relationDomainIdentity(field);

    // One Lookout multiset call supplies equality and additive/replace facts.
    const relation = compareRelation(currentItems, extractedArr, identity);
    if (relation.changed && relation.change) {
      // Check if extracted is purely additive (all current items still present)
      const isAdditive = currentItems.length > 0 &&
        relation.allCurrentRetained &&
        extractedArr.length > currentItems.length &&
        relation.hasNovelCandidate;

      changes[field] = {
        ...relation.change,
        ...reviewSignals(conf, fieldSources[field], now),
        mode: currentItems.length === 0 ? 'populate' : isAdditive ? 'add_items' : 'update',
        ...projectProvenance({ excerpt: excerpts[field], sourceUrl, locator: locators[field] }),
        ...(rowCitations[field] ? { rowCitations: rowCitations[field] } : {}),
      };
    }
  }

  return changes;
}

/**
 * Mean of the diffs' reported confidences, for queue ordering. Diffs with no
 * reported confidence are left out of the mean; when none reported one, the
 * result is 0 so an all-unknown proposal sorts with the least confident.
 */
export function computeOverallConfidence(proposedChanges: ProposedChanges): number {
  const known = (Object.values(proposedChanges) as FieldDiff[])
    .map((d) => d.confidence)
    .filter((c): c is number => typeof c === 'number');
  if (known.length === 0) return 0;
  const avg = known.reduce((sum, c) => sum + c, 0) / known.length;
  return Math.round(avg * 100) / 100;
}
