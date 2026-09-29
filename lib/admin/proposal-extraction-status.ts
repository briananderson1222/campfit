/**
 * The overall confidence to SHOW for a proposal, or null when no field change
 * carries a reported confidence. `overallConfidence` is stored as 0 in that
 * case so an all-unknown proposal sorts with the least confident (see
 * diff-engine's computeOverallConfidence); shown as a number it would read as
 * a reported "0%", which no extractor said. Traverse 2.0 made confidence
 * optional, so this case is now reachable in normal crawls.
 */
export function reportedOverallConfidence(proposal: {
  readonly overallConfidence?: number | null;
  readonly proposedChanges?: Readonly<Record<string, unknown>> | null;
}): number | null {
  const anyReported = Object.values(proposal.proposedChanges ?? {})
    .some((diff) => typeof (diff as { confidence?: unknown } | null | undefined)?.confidence === 'number');
  return anyReported && typeof proposal.overallConfidence === 'number' ? proposal.overallConfidence : null;
}

/** "82%", or "Not reported" when no confidence was reported. */
export function formatReportedConfidence(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'Not reported';
}

export interface StoredExtractionIncompleteness {
  readonly reason: string;
  readonly unreadRanges: number;
}

/**
 * The incomplete-extraction marker a crawl stored on the proposal's
 * `rawExtraction` (see lib/ingestion/extraction-completeness.ts), or null.
 * Proposals written before the marker existed never carry it.
 */
export function storedExtractionIncompleteness(
  rawExtraction: Record<string, unknown> | null | undefined,
): StoredExtractionIncompleteness | null {
  const marker = rawExtraction?.incomplete;
  if (!marker || typeof marker !== 'object') return null;
  const { reason, coverage } = marker as { reason?: unknown; coverage?: unknown };
  if (typeof reason !== 'string' || reason.length === 0) return null;
  const unreadRanges = Array.isArray(coverage)
    ? coverage.filter((entry) => (entry as { status?: unknown } | null)?.status !== 'complete').length
    : 0;
  return { reason, unreadRanges };
}

const LIST_FIELD_LABELS: Readonly<Record<string, string>> = {
  schedules: 'sessions',
  pricing: 'pricing',
  ageGroups: 'age groups',
  campTypes: 'camp types',
  categories: 'categories',
};

/**
 * The list fields whose updates the crawl withheld because its extraction
 * did not read the whole page (`rawExtraction.withheldListFields`), as the
 * review page names them. Empty for proposals that withheld nothing or were
 * written before the marker existed.
 */
export function storedWithheldListFields(rawExtraction: Record<string, unknown> | null | undefined): string[] {
  return storedFieldList(rawExtraction?.withheldListFields);
}

/**
 * Empty list fields the crawl filled although its extraction did not read the
 * whole page (`rawExtraction.populatedListFields`): nothing was removed, but
 * the list may be missing entries.
 */
export function storedPopulatedListFields(rawExtraction: Record<string, unknown> | null | undefined): string[] {
  return storedFieldList(rawExtraction?.populatedListFields);
}

function storedFieldList(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  return fields.filter((field): field is string => typeof field === 'string' && field.length > 0);
}

/** A list field's name for review and crawl-log text ("sessions", "age groups"). */
export function listFieldLabel(field: string): string {
  return LIST_FIELD_LABELS[field] ?? field;
}

/** The review page's notice for one list filled from an incomplete run. */
export function populatedListNotice(field: string): string {
  const label = listFieldLabel(field);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${label === 'pricing' ? 'was' : 'were'} filled from a run that did not read the whole page; the list may be missing entries.`;
}

/** The review page's notice for one withheld list. */
export function withheldListNotice(field: string): string {
  return `List updates for ${listFieldLabel(field)} were withheld because this run did not read the whole page; re-crawl, or edit manually.`;
}
