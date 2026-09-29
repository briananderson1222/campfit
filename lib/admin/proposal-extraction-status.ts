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
