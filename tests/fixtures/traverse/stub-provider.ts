/**
 * stub-provider.ts — a deterministic ExtractionProvider for the traverse
 * replay tests. No network, no API key; CI-safe.
 *
 * Traverse's provider interface hands the provider the ALREADY-PREPARED text
 * (`content`). This stub emits fixed proposals whose `excerpt` is taken
 * verbatim from that prepared text (looked up by a `needle` substring), which
 * is exactly what a well-behaved real provider does and what lets the proposal
 * survive traverse's excerpt-verification step. A `needle` that is absent from
 * the content is emitted anyway on purpose, so the test can assert traverse
 * DROPS it with the "excerpt not found in prepared content" warning.
 */

import type {
  ExtractionProvider,
  ProviderExtractionOutput,
} from "@kontourai/traverse";

export interface StubProposalSpec {
  fieldPath: string;
  candidateValue: unknown;
  /** Substring of the prepared text to use as the verbatim excerpt. */
  needle: string;
  /** Defaults to 0.9. Pass out-of-range (e.g. 1.4) to exercise clamping. */
  confidence?: number;
}

export interface StubProviderOptions {
  model?: string;
  /** Provider-side warnings to surface (merged into result.warnings). */
  warnings?: string[];
  /** If set, the provider throws — used to prove extract() never throws. */
  throwError?: string;
}

/**
 * Build a stub ExtractionProvider that returns `specs` as proposals. Excerpts
 * are resolved against the prepared `content` traverse passes in.
 */
export function createStubProvider(
  specs: StubProposalSpec[],
  opts: StubProviderOptions = {}
): ExtractionProvider {
  const model = opts.model ?? "stub-model";
  return {
    name: `stub-extraction-provider:${model}`,
    async extract({ content }): Promise<ProviderExtractionOutput> {
      if (opts.throwError) {
        throw new Error(opts.throwError);
      }
      const proposals = specs.map((spec) => {
        const idx = content.indexOf(spec.needle);
        // When found, the excerpt is a genuine verbatim substring; when not,
        // we still emit `needle` so extract() drops it with a warning.
        const excerpt = spec.needle;
        return {
          fieldPath: spec.fieldPath,
          candidateValue: spec.candidateValue,
          confidence: spec.confidence ?? 0.9,
          provenance: {
            excerpt,
            // Provisional — extract() re-derives the real chars:<a>-<b>.
            locator: idx >= 0 ? `provisional:${idx}` : "provisional:miss",
          },
          extractor: `stub-extraction-provider:${model}`,
        };
      });
      return {
        proposals,
        raw: { response: JSON.stringify({ specs: specs.length }), model },
        ...(opts.warnings ? { warnings: opts.warnings } : {}),
      };
    },
  };
}
