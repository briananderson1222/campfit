import type {
  ExtractionCoverageEntry,
  ExtractionPartialReason,
  ExtractionResult,
} from "@kontourai/traverse";
import type { ProposedChanges } from "@/lib/admin/types";
import { normalizeScalar, relationDomainIdentity, type RelationField } from "./diff-policy";

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
 * full, followed by the read entries it does not already hold (by the same
 * domain identity the diff uses), with mode `add_items`. Nothing is removed.
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
  const identity = isRelationField(field)
    ? relationDomainIdentity(field)
    : (value: unknown) => JSON.stringify(normalizeScalar(value));
  const keyOf = (value: unknown): string | null => {
    try {
      const resolved = identity(value);
      if (typeof resolved === "string") return resolved;
      return resolved.ok ? resolved.key : null;
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

function isRelationField(field: string): field is RelationField {
  return field === "ageGroups" || field === "schedules" || field === "pricing";
}
