import type {
  ExtractionCoverageEntry,
  ExtractionPartialReason,
  ExtractionResult,
} from "@kontourai/traverse";
import type { ProposedChanges } from "@/lib/admin/types";

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
 * On an incomplete run, withhold every list change (sessions, pricing, age
 * groups, camp types, categories). Approving a list change replaces the
 * stored list (relations are deleted and re-inserted, sessions without a
 * match are archived, tag arrays are overwritten), so a list read from part
 * of a page would delete entries that sat in unread text. Merging the read
 * entries into the live list is not safe either: labels are verbatim page
 * excerpts and dates are free text, so a live entry read back differently,
 * or a changed price or date, would be added next to the stale one. List
 * updates therefore wait for a complete run. A list proposed into an empty
 * field (`populate`) removes and duplicates nothing and is kept, as is every
 * scalar. `withheldFields` names the withheld lists so the review page can
 * say so.
 */
export function withholdListChangesFromIncompleteRun(
  changes: ProposedChanges,
  incomplete: ExtractionIncompleteness | undefined,
): { changes: ProposedChanges; warnings: string[]; withheldFields: string[] } {
  if (!incomplete) return { changes, warnings: [], withheldFields: [] };
  const kept: ProposedChanges = {};
  const warnings: string[] = [];
  const withheldFields: string[] = [];
  for (const [field, diff] of Object.entries(changes)) {
    if (Array.isArray(diff.new) && diff.mode !== "populate") {
      withheldFields.push(field);
      warnings.push(
        `${field} change withheld: ${describeIncompleteness(incomplete)}, so entries missing from this list may sit in unread text and approving it could delete them; re-crawl, or edit manually`,
      );
      continue;
    }
    kept[field] = diff;
  }
  return { changes: kept, warnings, withheldFields };
}
