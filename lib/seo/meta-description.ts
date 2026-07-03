/**
 * Meta-description helpers.
 *
 * Fixes audit finding F-04: camp `<meta description>`s were built with
 * `description.slice(0, 120)`, which sliced mid-word ("…children between")
 * and left doubled whitespace where fragments were concatenated
 * ("Blue Sky  For ages"). These helpers truncate at a word boundary and
 * collapse whitespace so snippets read cleanly in search/social cards.
 */

/**
 * Truncate `text` to at most `max` characters without cutting a word in half.
 * Collapses internal whitespace and appends an ellipsis when truncated.
 */
export function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  // Drop any trailing punctuation/dash left dangling by the cut, then ellipsize.
  return base.replace(/[\s.,;:–—-]+$/u, "") + "…";
}

/**
 * Join description fragments into a single clean line: drops empty/false
 * parts, single-spaces the result, and trims. Prevents the doubled spaces
 * seen when an upstream fragment already ended in whitespace.
 */
export function joinMetaDescription(
  parts: Array<string | number | null | undefined | false>
): string {
  return parts
    .filter((p): p is string => Boolean(p))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
