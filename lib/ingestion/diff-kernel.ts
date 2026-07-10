/**
 * Pure comparison/provenance mechanics shared by CampFit's two proposal
 * paths. Field selection, confidence policy, suppression, and proposal modes
 * deliberately remain in their callers.
 */

export interface ValueChange {
  old: unknown;
  new: unknown;
}

export interface RelationFacts {
  allCurrentRetained: boolean;
  hasNovelCandidate: boolean;
}

export interface ProvenanceProjectionOptions {
  excerpt?: string;
  sourceUrl?: string;
  /** First-pass proposals historically retain `excerpt: ""`; recrawl omits it. */
  includeEmptyExcerpt?: boolean;
}

export function stableOuterArrayIdentity(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value) as string;
  const sorted = [...value].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))
  );
  return JSON.stringify(sorted);
}

function stableObjectString(value: unknown): string {
  if (Array.isArray(value)) return stableOuterArrayIdentity(value);
  if (!value || typeof value !== "object") return String(value ?? "");
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

/** Scalar normalization preserved from the recrawl diff engine. */
export function normalizeScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "object") return stableObjectString(value);
  return String(value).trim().toLowerCase();
}

export function changeWhenDifferent(
  oldValue: unknown,
  newValue: unknown,
  equal: (oldValue: unknown, newValue: unknown) => boolean
): ValueChange | null {
  return equal(oldValue, newValue) ? null : { old: oldValue, new: newValue };
}

export function scalarChange(oldValue: unknown, newValue: unknown): ValueChange | null {
  return changeWhenDifferent(
    oldValue,
    newValue,
    (oldCandidate, newCandidate) => normalizeScalar(oldCandidate) === normalizeScalar(newCandidate)
  );
}

export function outerArrayChange(oldValue: unknown[], newValue: unknown[]): ValueChange | null {
  return changeWhenDifferent(
    oldValue,
    newValue,
    (oldCandidate, newCandidate) =>
      stableOuterArrayIdentity(oldCandidate) === stableOuterArrayIdentity(newCandidate)
  );
}

export function relationFacts(currentItems: unknown[], candidateItems: unknown[]): RelationFacts {
  const currentIdentities = new Set(currentItems.map(stableOuterArrayIdentity));
  const candidateIdentities = new Set(candidateItems.map(stableOuterArrayIdentity));
  return {
    allCurrentRetained: currentItems.every((item) => candidateIdentities.has(stableOuterArrayIdentity(item))),
    hasNovelCandidate: candidateItems.some((item) => !currentIdentities.has(stableOuterArrayIdentity(item))),
  };
}

/** Preserve excerpt-before-sourceUrl ordering and each caller's omission policy. */
export function projectProvenance({
  excerpt,
  sourceUrl,
  includeEmptyExcerpt = false,
}: ProvenanceProjectionOptions): { excerpt?: string; sourceUrl?: string } {
  return {
    ...(includeEmptyExcerpt || excerpt ? { excerpt: excerpt ?? "" } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}
