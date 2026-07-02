/**
 * resolve-extraction-provider.ts — datum-backed resolution of the traverse
 * Anthropic-compatible extraction provider, for LIVE (non-CI) paths only.
 *
 * `@kontourai/datum@^0.3.0`'s `resolve(ref)` reads `.datum/config.json`
 * (repo, committed — see that file for the `zai` / `anthropic` providers and
 * the `extraction-default` role) deep-merged under `~/.config/kontour/datum.json`
 * (user), and returns `{ provider, kind, baseUrl?, apiKey, model }` — which
 * lines up 1:1 with `createAnthropicExtractionProvider`'s options (see
 * datum's README, "Wire it into traverse"). This module is that wiring.
 *
 * `.datum/config.json` (not `.kontour/datum.json`) is the portfolio
 * convention for a product's durable, committed config in a *consuming*
 * repo — `.kontour*` is reserved for gitignored runtime state. `resolve()`
 * discovers `.datum/config.json` by default as of datum 0.3.0.
 *
 * Which ref resolves is controlled by (highest precedence first):
 *   1. `TRAVERSE_ROLE` (this repo's env var, read here) — picks a different
 *      datum ref/role entirely, e.g. `TRAVERSE_ROLE=anthropic-default`.
 *   2. `DATUM_ROLE_<ROLE>` (datum-native escape hatch, read inside
 *      `resolve()`) — overrides what a given role name points at without
 *      touching `TRAVERSE_ROLE` or the config file. See datum's README.
 *   3. the `extraction-default` role in `.datum/config.json`.
 *
 * `TRAVERSE_MODEL` / `ANTHROPIC_BASE_URL` remain supported as explicit,
 * final overrides on top of whatever datum resolves — e.g. pinning a model
 * for one run without editing config or exporting `DATUM_ROLE_*`. Prefer
 * datum-native mechanisms (`DATUM_ROLE_*`, `DATUM_BASEURL_*`, or just editing
 * `.datum/config.json`) for anything more than a one-off override.
 *
 * NEVER imported from a CI-executed path: `test:traverse-replay` supplies its
 * own stub `ExtractionProvider` (tests/fixtures/traverse/stub-provider.ts)
 * and does not import this module, so CI needs no datum config and no key.
 */
import { resolve } from "@kontourai/datum";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";
import type { ExtractionProvider } from "@kontourai/traverse";

export interface ResolvedExtractionProvider {
  /** The traverse ExtractionProvider, ready to pass to runTraverseExtraction/extract. */
  provider: ExtractionProvider;
  /** The datum ref that was resolved (TRAVERSE_ROLE or "extraction-default"). */
  ref: string;
  /** Provider id datum resolved to (e.g. "zai", "anthropic"). */
  datumProvider: string;
  /** Model id actually passed to the SDK (after TRAVERSE_MODEL override, if any). */
  model: string;
  /** Base URL actually passed to the SDK (after ANTHROPIC_BASE_URL override, if any). */
  baseUrl?: string;
}

/**
 * Resolve the extraction provider for a live traverse run via datum. Throws
 * `DatumError` (see `@kontourai/datum`'s `DatumErrorCode`) when no role/config
 * resolves or the referenced key is unset — callers on live paths (e.g.
 * `scripts/traverse-parity.ts`) are expected to catch it and print
 * NOT_VERIFIED-style run instructions rather than crash.
 */
export function resolveExtractionProvider(): ResolvedExtractionProvider {
  const ref = process.env.TRAVERSE_ROLE || "extraction-default";
  const resolved = resolve(ref);

  const model = process.env.TRAVERSE_MODEL || resolved.model;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || resolved.baseUrl;

  const provider = createAnthropicExtractionProvider({
    apiKey: resolved.apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
  });

  return { provider, ref, datumProvider: resolved.provider, model, baseUrl };
}
