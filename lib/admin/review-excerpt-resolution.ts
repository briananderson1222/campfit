export type ReviewExcerptResolution =
  | { state: 'verified'; resolvedExcerpt: string; locator: string }
  | { state: 'approximate_stale'; resolvedExcerpt?: string; locator?: string }
  | { state: 'unavailable' };

export function parseCharsLocator(locator: string): { start: number; end: number } | undefined {
  const match = /^chars:(\d+)-(\d+)$/.exec(locator);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
    ? { start, end }
    : undefined;
}

/** Exact-only resolver. A locator wins when supplied; otherwise indexOf selects the first occurrence. */
export function resolveReviewExcerpt(
  excerpt: string,
  snapshotBody: string | null | undefined,
  locator?: string | null,
): ReviewExcerptResolution {
  if (!excerpt || typeof snapshotBody !== 'string') return { state: 'unavailable' };

  if (locator) {
    const bounds = parseCharsLocator(locator);
    if (!bounds || bounds.end > snapshotBody.length) return { state: 'approximate_stale', locator };
    return snapshotBody.slice(bounds.start, bounds.end) === excerpt
      ? { state: 'verified', resolvedExcerpt: excerpt, locator: `chars:${bounds.start}-${bounds.end}` }
      : { state: 'approximate_stale', resolvedExcerpt: excerpt, locator };
  }

  const start = snapshotBody.indexOf(excerpt);
  if (start < 0) return { state: 'approximate_stale', resolvedExcerpt: excerpt };
  return { state: 'verified', resolvedExcerpt: excerpt, locator: `chars:${start}-${start + excerpt.length}` };
}
