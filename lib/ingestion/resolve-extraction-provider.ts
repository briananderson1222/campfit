/**
 * resolve-extraction-provider.ts — datum-backed resolution of the traverse
 * Relay-backed extraction provider, for LIVE (non-CI) paths only.
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
 * `TRAVERSE_MAX_TOKENS` overrides the Anthropic adapter's response token
 * budget (default {@link DEFAULT_EXTRACTION_MAX_TOKENS}, currently 2048 —
 * the adapter's own default). Counter-intuitively, RAISING this for the
 * per-item schema made glm-5.2-via-Z.AI extraction WORSE, not better: probed
 * live against the same idtech snapshot at 2048/4096/6144/8192,
 * `stop_reason === "max_tokens"` fired at EVERY budget (this model spends
 * output tokens on something ahead of the tool_use block — the response
 * never has room to finish it once the budget grows past ~2048), but at
 * 4096+ the response was truncated before ANY valid tool_use JSON completed
 * (0 proposals); only 2048 forced the model to reach usable tool_use content
 * before truncating. See the idtech row and its root-cause note in
 * docs/cutover-report-2026-07.md. Left overridable per-provider/model via
 * this env var since a different provider may not share this behavior.
 *
 * Revisited for traverse 0.5.0's large-page chunking (2026-07 addendum, see
 * docs/cutover-report-2026-07.md): `maxContentChars` (unset here, so the
 * adapter/traverse default of 32_000 applies) became the PER-CHUNK content
 * budget, not a whole-page one — orthogonal to this module's `maxTokens`,
 * which is still the per-CALL (i.e. per-chunk) OUTPUT budget. Chunking cuts
 * how much a single tool-use response has to enumerate (idtech's ~23 courses
 * split across chunks instead of one call), which is what actually recovers
 * most of idtech's under-extraction — DEFAULT_EXTRACTION_MAX_TOKENS itself
 * did not need to change: a live idtech re-probe under 0.5.1 still hit
 * `stop_reason === "max_tokens"` on EVERY chunk at 2048, so the same
 * per-call ceiling (and the same "raising it makes glm-5.2 worse, not
 * better" quirk above) still holds — chunking works around the ceiling by
 * shrinking what has to fit under it per call, not by raising it.
 *
 * Only imported by LIVE scripts (scripts/scrape.ts, scripts/cutover-report.ts) —
 * never by `test:traverse-replay`, which supplies its own stub
 * `ExtractionProvider` (tests/fixtures/traverse/stub-provider.ts), so CI needs
 * no datum config and no key.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolve } from "@kontourai/datum";
import { createDispatchRuntime, type DispatchReceipt } from "@kontourai/dispatch";
import type { ModelRuntime } from "@kontourai/relay";
import { createModelRuntimeProfile, parseModelRuntimeProfile } from "@kontourai/relay/runtime-profile";
import { createRelayExtractionProvider } from "@kontourai/traverse/relay";
import type { ExtractionProvider } from "@kontourai/traverse";

/**
 * Default output token budget for the Anthropic adapter. Explicitly set to
 * match the adapter's own built-in default (2048) — see the module doc
 * above for why raising it empirically made glm-5.2-via-Z.AI extraction
 * WORSE on the per-item schema, not better.
 */
export const DEFAULT_EXTRACTION_MAX_TOKENS = 2048;

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
  /** Output token budget actually passed to the SDK (after TRAVERSE_MAX_TOKENS override, if any). */
  maxTokens: number;
}

function persistDispatchReceipt(receiptPath: string, receipt: DispatchReceipt): void {
  const resolved = path.resolve(receiptPath);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  appendFileSync(resolved, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
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
  const maxTokens = process.env.TRAVERSE_MAX_TOKENS
    ? Number(process.env.TRAVERSE_MAX_TOKENS)
    : DEFAULT_EXTRACTION_MAX_TOKENS;

  const configuredProfiles = (process.env.TRAVERSE_RUNTIME_PROFILES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const profileValues = configuredProfiles.length > 0
    ? configuredProfiles
    : [`anthropic:${model}`];
  const allowPromptedStructuredOutput = process.env.TRAVERSE_ALLOW_PROMPTED_STRUCTURED_OUTPUT === "true";
  const candidates = profileValues.map((value, index) => {
    const spec = parseModelRuntimeProfile(value);
    const runtime = createModelRuntimeProfile({
      ...spec,
      cwd: process.cwd(),
      allowPromptedStructuredOutput,
      ...(spec.profile === "anthropic" ? { apiKey: resolved.apiKey, ...(baseUrl ? { baseUrl } : {}) } : {}),
    });
    return { id: `candidate-${index}`, runtime };
  });
  const receiptPath = process.env.TRAVERSE_DISPATCH_RECEIPT_PATH;
  const maxAttemptsValue = process.env.TRAVERSE_DISPATCH_MAX_ATTEMPTS;
  const maxAttempts = maxAttemptsValue ? Number(maxAttemptsValue) : undefined;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
    throw new Error("TRAVERSE_DISPATCH_MAX_ATTEMPTS must be a positive integer");
  }
  const runtime = candidates.length === 1 && !receiptPath && maxAttempts === undefined
    ? candidates[0]!.runtime
    : createCampfitDispatchRuntime(candidates, {
        allowPromptedStructuredOutput,
        ...(receiptPath ? { receiptPath } : {}),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      });
  const provider = createRelayExtractionProvider({ runtime, maxTokens });

  return { provider, ref, datumProvider: resolved.provider, model, baseUrl, maxTokens };
}

function createCampfitDispatchRuntime(
  candidates: readonly { id: string; runtime: ModelRuntime }[],
  options: { allowPromptedStructuredOutput: boolean; receiptPath?: string; maxAttempts?: number },
): ModelRuntime {
  const runtimes = new Map(candidates.map(({ id, runtime }) => [id, runtime]));
  return createDispatchRuntime({
    id: "campfit-extraction-dispatch",
    capabilities: { structuredTools: true, streaming: false, abort: true, usage: true },
    runtimes,
    plan: {
      schemaVersion: 1,
      role: "campfit-extraction",
      candidates: candidates.map(({ id, runtime }) => ({
        id,
        runtimeId: id,
        evidence: {
          level: "declared" as const,
          capabilities: ["structured-tools", "abort", "usage"],
          structuredToolsFidelity: runtime.capabilities().structuredToolsFidelity,
        },
      })),
      budget: { maxAttempts: options.maxAttempts ?? candidates.length },
      policy: {
        retryRuntimeFailures: true,
        minimumStructuredToolsFidelity: options.allowPromptedStructuredOutput ? "prompted" : "native",
      },
    },
    ...(options.receiptPath
      ? { onReceipt: (receipt: DispatchReceipt) => persistDispatchReceipt(options.receiptPath!, receipt) }
      : {}),
  });
}
