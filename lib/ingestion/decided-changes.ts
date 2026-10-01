/**
 * decided-changes.ts — do not ask a reviewer the same question twice.
 *
 * An approval changes the camp, so the next crawl reads the page once more
 * (crawl-pipeline.ts, `skipEligibleFingerprint`). A model then words a value a
 * little differently, or cites other words for the same row, and the diff
 * reports a change the reviewer has already decided from that evidence.
 *
 * A change is withheld only when the field was approved in review
 * (`fieldSources[field].approvedAt`) and the evidence is the evidence that
 * approval rested on:
 *  - a single value: the new excerpt is the approved excerpt;
 *  - a row list (`ageGroups`, `schedules`, `pricing`): the new rows cite the
 *    same excerpts as the stored rows (their labels), or carry the same values
 *    as the stored rows under other labels.
 * Anything else is proposed: a different excerpt, a row added or removed, a
 * field never approved. Enum lists and `socialLinks` are always proposed,
 * because their one stored excerpt cites only their first entry and cannot
 * show that the rest is unchanged.
 *
 * Every withheld field is reported, never dropped silently.
 */
import type { ProposedChanges } from '@/lib/admin/types';
import { projectAgeGroupDomain, projectPricingDomain, projectScheduleDomain, type RelationField } from './diff-policy';

/** A camp's `fieldSources` entry, as review-apply writes it on approval. */
export interface DecidedFieldSource {
  approvedAt?: string;
  excerpt?: string | null;
}

export interface DecidedChange {
  field: string;
  approvedAt: string;
  /** `same-excerpt`: the cited text is the approved text. `same-values`: the rows carry the stored values. */
  reason: 'same-excerpt' | 'same-values';
}

const RELATION_FIELDS: readonly RelationField[] = ['ageGroups', 'schedules', 'pricing'];

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : [];
}

/** A row's values without its label, which is the excerpt it was read from. */
function rowValuesKey(field: RelationField, row: unknown): string {
  const projected = field === 'ageGroups' ? projectAgeGroupDomain(row) : field === 'schedules' ? projectScheduleDomain(row) : projectPricingDomain(row);
  const { label: _label, ...values } = projected;
  return JSON.stringify(values);
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function decidedReason(field: string, diff: ProposedChanges[string], source: DecidedFieldSource): DecidedChange['reason'] | null {
  if ((RELATION_FIELDS as readonly string[]).includes(field)) {
    const relation = field as RelationField;
    const stored = rowsOf(diff.old);
    const proposed = rowsOf(diff.new);
    if (stored.length === 0 || proposed.length === 0) return null;
    const labels = (rows: Record<string, unknown>[]) => rows.map((row) => normalizeText(row.label));
    if (labels(proposed).every(Boolean) && sameMultiset(labels(stored), labels(proposed))) return 'same-excerpt';
    if (sameMultiset(stored.map((row) => rowValuesKey(relation, row)), proposed.map((row) => rowValuesKey(relation, row)))) return 'same-values';
    return null;
  }
  // One stored excerpt stands for the whole value only when the value is one
  // extracted value, not a list or a folded object.
  if (typeof diff.new === 'object' && diff.new !== null) return null;
  const approved = normalizeText(source.excerpt);
  return approved !== '' && approved === normalizeText(diff.excerpt) ? 'same-excerpt' : null;
}

/**
 * Split a computed diff into the changes to propose and the ones a reviewer
 * already decided from the same evidence.
 */
export function withholdDecidedChanges(
  changes: ProposedChanges,
  fieldSources: Readonly<Record<string, DecidedFieldSource | undefined>>,
): { changes: ProposedChanges; decided: DecidedChange[]; warnings: string[] } {
  const kept: ProposedChanges = {};
  const decided: DecidedChange[] = [];
  for (const [field, diff] of Object.entries(changes)) {
    const source = fieldSources[field];
    const reason = source?.approvedAt ? decidedReason(field, diff, source) : null;
    if (reason && source?.approvedAt) decided.push({ field, approvedAt: source.approvedAt, reason });
    else kept[field] = diff;
  }
  const warnings = decided.map((item) =>
    item.reason === 'same-excerpt'
      ? `${item.field}: not proposed again — the page text it cites is the text a reviewer approved on ${item.approvedAt.slice(0, 10)}`
      : `${item.field}: not proposed again — the entries have the values a reviewer approved on ${item.approvedAt.slice(0, 10)}, only their cited text differs`);
  return { changes: kept, decided, warnings };
}
