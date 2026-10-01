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

/**
 * Values the extraction proposed that failed their field's type check (an
 * enum member outside the allowed set, a date with no year), keyed by field.
 * They are not part of any proposed change; the review page says so.
 */
export function storedRefusedValues(rawExtraction: Record<string, unknown> | null | undefined): Array<{ field: string; values: string[] }> {
  const stored = rawExtraction?.refusedValues;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
  return Object.entries(stored as Record<string, unknown>)
    .map(([field, values]) => ({ field, values: storedFieldList(values) }))
    .filter((entry) => entry.values.length > 0);
}

export function refusedValuesNotice(entry: { field: string; values: readonly string[] }): string {
  const shown = entry.values.slice(0, 6).map((value) => `"${value}"`).join(', ');
  const more = entry.values.length > 6 ? ` and ${entry.values.length - 6} more` : '';
  const verb = entry.values.length === 1 ? 'is' : 'are';
  return `${listFieldLabel(entry.field).replace(/^./, (c) => c.toUpperCase())}: the extraction also returned ${shown}${more}, which ${verb} not valid for this field and ${verb} not proposed.`;
}

/**
 * Fields for which the page stated more than one distinct value
 * (`rawExtraction.conflictingValues`). None was proposed.
 */
export function storedConflictingValues(rawExtraction: Record<string, unknown> | null | undefined): Array<{ field: string; values: string[] }> {
  const stored = rawExtraction?.conflictingValues;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
  return Object.entries(stored as Record<string, unknown>)
    .map(([field, values]) => ({ field, values: storedFieldList(values) }))
    .filter((entry) => entry.values.length > 1);
}

export function conflictingValuesNotice(entry: { field: string; values: readonly string[] }): string {
  const shown = entry.values.slice(0, 6).map((value) => `"${value}"`).join(', ');
  const more = entry.values.length > 6 ? ` and ${entry.values.length - 6} more` : '';
  return `${entry.field.replace(/^./, (c) => c.toUpperCase())}: the page states ${entry.values.length} different values (${shown}${more}). None is proposed; check the page and edit the field manually if one is right.`;
}

/** Entries the extraction left out of a list because an entry with the same values was kept (`rawExtraction.droppedEntries`). */
export function storedDroppedEntries(rawExtraction: Record<string, unknown> | null | undefined): string[] {
  return storedFieldList(rawExtraction?.droppedEntries);
}

/** Programs a multi-program page listed, when the extraction could not separate them into items. */
export function storedMultiProgram(rawExtraction: Record<string, unknown> | null | undefined): { names: string[]; withheldFields: string[] } | null {
  const stored = rawExtraction?.multiProgram;
  if (!stored || typeof stored !== 'object') return null;
  const names = storedFieldList((stored as { names?: unknown }).names);
  if (names.length < 2) return null;
  return { names, withheldFields: storedFieldList((stored as { withheldFields?: unknown }).withheldFields) };
}

export function multiProgramNotice(multiProgram: { names: readonly string[]; withheldFields: readonly string[] }): string {
  const others = multiProgram.withheldFields.filter((field) => field !== 'name');
  return `This page lists ${multiProgram.names.length} programs (${multiProgram.names.join(', ')}). The camp's name is not proposed from any one of them`
    + (others.length > 0 ? `, and neither ${others.length === 1 ? 'is' : 'are'} ${others.join(', ')}, where the programs differ` : '')
    + '. Sessions, pricing and age groups below combine every program on the page.';
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
