import type {
  ExtractionCoverageEntry,
  ExtractionPartialReason,
  ExtractionResult,
} from "@kontourai/traverse";
import type { ProposedChanges } from "@/lib/admin/types";
import { normalizeScalar, type RelationField } from "./diff-policy";
import { scheduleNaturalKey } from "@/lib/admin/session-identity";

/**
 * Why an extraction did not read and answer all of its prepared text, as
 * Traverse reports it (`ExtractionResult.partial`, and per-chunk `coverage`).
 * Since Traverse 2.0 this also covers chunk losses on a run that otherwise
 * succeeded: a provider failure on one chunk, content cut at the content cap,
 * or an answer stopped at the output cap. Such a run is not an error, but it
 * must never read as a complete one.
 *
 * Same shape as Lookout's `ProposalSetIncompleteness`, so it is passed to an
 * observation unchanged.
 */
export interface ExtractionIncompleteness {
  readonly reason: ExtractionPartialReason;
  readonly coverage?: readonly ExtractionCoverageEntry[];
}

export function extractionIncompleteness(
  result: Pick<ExtractionResult, "partial" | "coverage"> | undefined,
): ExtractionIncompleteness | undefined {
  if (!result?.partial) return undefined;
  return { reason: result.partial.reason, ...(result.coverage ? { coverage: result.coverage } : {}) };
}

/** Coverage ranges that were not read or whose answer was cut off. */
export function unreadRangeCount(incomplete: ExtractionIncompleteness): number {
  return (incomplete.coverage ?? []).filter((entry) => entry.status !== "complete").length;
}

/**
 * Whether any answer in the run stopped at the provider's output cap. The
 * partial reason names only the first loss, so coverage is read as well.
 */
export function hitOutputCap(incomplete: ExtractionIncompleteness): boolean {
  return incomplete.reason === "output-truncated"
    || (incomplete.coverage ?? []).some((entry) => entry.status === "output-truncated");
}

/** One line an operator can read in a crawl log or on a proposal. */
export function describeIncompleteness(incomplete: ExtractionIncompleteness): string {
  const total = incomplete.coverage?.length ?? 0;
  const unread = unreadRangeCount(incomplete);
  const ranges = total > 0 ? `: ${unread} of ${total} text range(s) not fully read` : "";
  return `extraction incomplete (${incomplete.reason})${ranges}`;
}

/**
 * On an incomplete run, a list change may only ADD entries. Approving a list
 * change replaces the stored list (relations are deleted and re-inserted,
 * sessions without a match are archived, tag arrays are overwritten), so a
 * list shortened only because its other entries sat in text that was never
 * read would delete them. Output truncation on long pages makes this common,
 * so withholding every list change would also stall pure additions.
 *
 * Each list change is rewritten as additions only: the current list, in
 * full, followed by the read entries it does not already hold (by the
 * identity in entryKey below), with mode `add_items`. Nothing is removed.
 * A change with no new entry is dropped. A change whose current list is not
 * known (the provider-source path diffs lists against nothing, `old: null`)
 * or whose identity cannot be computed is withheld, because no additions-only
 * form of it can be proven. A list proposed into an empty field (`populate`)
 * removes nothing and is kept, as is every scalar.
 */
export function limitListChangesToAdditions(
  changes: ProposedChanges,
  incomplete: ExtractionIncompleteness | undefined,
): { changes: ProposedChanges; warnings: string[] } {
  if (!incomplete) return { changes, warnings: [] };
  const kept: ProposedChanges = {};
  const warnings: string[] = [];
  const why = describeIncompleteness(incomplete);
  for (const [field, diff] of Object.entries(changes)) {
    if (!Array.isArray(diff.new) || diff.mode === "populate") {
      kept[field] = diff;
      continue;
    }
    const current = Array.isArray(diff.old) ? diff.old : null;
    const additions = current ? novelEntries(field, current, diff.new) : null;
    if (!current || !additions) {
      warnings.push(`${field} change withheld: ${why}, and no additions-only form of it can be proven, so approving it could delete entries that sat in unread text`);
      continue;
    }
    if (additions.removed > 0) {
      warnings.push(`${field}: ${additions.removed} current entr${additions.removed === 1 ? "y" : "ies"} not found in the read text kept, not removed (${why})`);
    }
    if (additions.novel.length === 0) continue;
    kept[field] = { ...diff, old: current, new: [...current, ...additions.novel], mode: "add_items" };
  }
  return { changes: kept, warnings };
}

function novelEntries(
  field: string,
  current: readonly unknown[],
  candidate: readonly unknown[],
): { novel: unknown[]; removed: number } | null {
  const keyOf = (value: unknown): string | null => {
    try {
      return entryKey(field, value);
    } catch {
      return null;
    }
  };
  const currentKeys = new Set<string>();
  for (const item of current) {
    const key = keyOf(item);
    if (key === null) return null;
    currentKeys.add(key);
  }
  const candidateKeys = new Set<string>();
  const novel: unknown[] = [];
  for (const item of candidate) {
    const key = keyOf(item);
    if (key === null) return null;
    if (!currentKeys.has(key) && !candidateKeys.has(key)) novel.push(item);
    candidateKeys.add(key);
  }
  const removed = [...currentKeys].filter((key) => !candidateKeys.has(key)).length;
  return { novel, removed };
}

/**
 * "Is this the same entry?" for the additions-only rewrite, built only from
 * the fields the extraction fills. The recrawl sends startTime/endTime,
 * discount notes, age qualifiers and grades as null, so the diff's full
 * domain identity would read every current entry that has one of them set
 * as new, and approving would add a blanked duplicate.
 *  - sessions: the apply path's own natural key (session-identity.ts's
 *    scheduleNaturalKey: trimmed, case-insensitive label + start + end date),
 *    so an entry counted as existing here is the row reconciliation matches;
 *  - price tiers: case-insensitive label + amount + unit;
 *  - age groups: case-insensitive label + min age + max age;
 *  - tag arrays: the diff's scalar normalization (case-insensitive).
 * Null means the key cannot be computed (no label), and the change is then
 * withheld rather than guessed.
 */
function entryKey(field: string, value: unknown): string | null {
  if (!isRelationField(field)) return JSON.stringify(normalizeScalar(value));
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const label = typeof entry.label === "string" && entry.label.trim() ? entry.label : null;
  if (label === null) return null;
  const text = (item: unknown): string | null => (typeof item === "string" && item !== "" ? item : null);
  const number = (item: unknown): string => (typeof item === "number" && Number.isFinite(item) ? String(item) : "");
  if (field === "schedules") return scheduleNaturalKey(label, text(entry.startDate), text(entry.endDate));
  const name = label.trim().toLowerCase();
  if (field === "pricing") return `${name}|${number(entry.amount)}|${typeof entry.unit === "string" ? entry.unit : ""}`;
  return `${name}|${number(entry.minAge)}|${number(entry.maxAge)}`;
}

function isRelationField(field: string): field is RelationField {
  return field === "ageGroups" || field === "schedules" || field === "pricing";
}
