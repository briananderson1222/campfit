/**
 * prepared-text.ts — the prepared page text an extraction's `chars:` locators
 * point into, kept beside the extraction result.
 *
 * Traverse does not embed the prepared text in its result. Session times are
 * placed by the line they are on (traverse-item-grouping.ts), so the crawl
 * paths re-prepare the content (the same `prepareAndChunk` the citation check
 * uses, lib/admin/citation-text.ts) and keep it only when every proposal's
 * locator slices out exactly its excerpt. A text that does not line up is
 * not kept; the grouping then compares cited spans only (fail closed).
 */
import { prepareAndChunk, type ContentType, type ExtractionResult } from '@kontourai/traverse';

const texts = new WeakMap<object, string>();

/** Remember the prepared text of `result`, when it lines up with every locator. Returns it, or undefined. */
export function rememberPreparedText(
  result: ExtractionResult,
  content: string | Uint8Array,
  contentType: ContentType,
): string | undefined {
  let fullText: string;
  try {
    const prepared = prepareAndChunk(content as never, contentType);
    if (prepared.error !== undefined) return undefined;
    fullText = prepared.fullText;
  } catch {
    return undefined;
  }
  const linesUp = result.proposals.every((proposal) => {
    const m = /^chars:(\d+)-(\d+)$/.exec(proposal.provenance.locator);
    return m !== null && fullText.slice(Number(m[1]), Number(m[2])) === proposal.provenance.excerpt;
  });
  if (!linesUp) return undefined;
  texts.set(result, fullText);
  return fullText;
}

/** The prepared text remembered for `result`, if any. */
export function preparedTextOf(result: ExtractionResult | undefined | null): string | undefined {
  return result ? texts.get(result) : undefined;
}
