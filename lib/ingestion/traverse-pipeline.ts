/**
 * traverse-pipeline.ts — THE ingestion pipeline (full cutover, owner
 * directive 2026-07). Replaces lib/ingestion/traverse-ingestion.ts (the
 * Slice-2b FLAGGED path that only routed 2 selector-dead sources while a
 * legacy CSS-selector scraper ran in shadow). There is no more flag, no more
 * "rotted source" split, and no more legacy shadow run — every source in
 * lib/ingestion/sources.ts goes through this same path:
 *
 *   fetch (with snapshot capture, robots/politeness honored) -> per-item
 *   schema-directed extraction -> group into items (traverse-item-grouping.ts)
 *   -> map each item to a ProposedChanges record (traverse-extractor.ts) ->
 *   route each item to the injected review sink (createProposal in prod).
 *
 * Design (unchanged discipline from the pilot):
 *  - This module owns ONLY the fetch->extract->group->route routing. It
 *    never touches the DB itself; `sink` is injected, so the whole path is
 *    exercised in CI with a stub provider, an in-memory snapshot store, an
 *    injected network-free `fetch`, and a fake sink (see
 *    scripts/test-traverse-replay.ts). scripts/scrape.ts passes a sink that
 *    resolves a campId (upserting a per-item anchor camp) + crawlRunId and
 *    calls `createProposal`.
 *  - Fetch mode defaults to `live-with-capture`: every extraction is
 *    captured to the snapshot store so every proposal is traceable to
 *    byte-identical bytes and a future run can replay (`mode: "replay"`).
 *  - Per-SOURCE failure isolation (mirrors lib/ingestion/ingestion-runner.ts's
 *    contract): a fetch/extraction failure on one source never throws and
 *    never stops the next source in a sweep.
 *  - Cost/latency capture (closes half of campfit#39): every source result
 *    records `tokensUsed` and `providerCalls` — since @kontourai/traverse@0.5.0's
 *    large-page chunking, a single source's page can issue MULTIPLE
 *    `provider.extract()` calls (one per chunk, up to `maxChunks`), so these
 *    are read from `ExtractionResult.totalTokensUsed`/`.providerCalls`
 *    (0.8.0, kontourai/traverse#19) — the SUMMED/counted aggregate across
 *    every chunk's call, always populated. Reading `raw.tokensUsed` directly
 *    (the pre-0.8.0 approach) silently undercounted any multi-chunk page: it
 *    is only the LAST chunk's provider response. `latencyMs` (wall time for
 *    the fetch+extract call(s) — see the shell-retry seam below) is captured
 *    alongside, so model/provider choice is a data-backed decision (see
 *    docs/cutover-report-2026-07.md).
 *
 * Shell-detection auto-retry (closes campfit#41 follow-up /
 * kontourai/traverse#11). @kontourai/traverse@0.6.0 added a machine-actionable
 * warning to `ExtractionResult.warnings` when a page's prepared text looks
 * like an un-rendered JS shell (`SHELL_WARNING_CODE`,
 * `"js-shell-suspected: …"`), plus a downgraded variant when the page also
 * carried usable embedded state (`SHELL_WARNING_CODE_EMBEDDED`,
 * `"js-shell-suspected-embedded-state-available: …"`) — see
 * `node_modules/@kontourai/traverse/README.md`'s "SPA / JS-rendered pages"
 * section. `runTraversePipelineForSource` acts on both:
 *  - Pure `js-shell-suspected` on a NON-render source: retry that source
 *    exactly ONCE with `SourceConfig.render: true` (the same native seam a
 *    curated `render: true` source uses), re-running the SAME
 *    snapshot-capture -> extraction path. Skipped
 *    entirely (never issued) when this run has no caller-injected
 *    `FetchSourceOptions.renderImpl` configured — see `retrySkippedNoRenderer`
 *    below. The retry's results REPLACE the first attempt's for routing (it
 *    is a strictly better read of the page) UNLESS the render itself fails,
 *    in which case the first attempt's (partial) results are kept — partial
 *    beats none. Either way the escalation is recorded on the result
 *    (`shellEscalation`) so the sweep summary can surface it.
 *  - Downgraded `js-shell-suspected-embedded-state-available`: no render (the
 *    sidecar already makes the page extractable) — the sidecar's PRESENCE and
 *    counts are recorded on the result (`embeddedStateAvailable`) so the
 *    owner can see which sources could adopt sidecar-based extraction later.
 *    Mapping the sidecar's contents onto proposals is out of scope here.
 *  - A `render: true` source never re-enters this seam (it is already
 *    rendered) — never more than one render per source per run.
 */

import { fetchAndExtract } from "@kontourai/traverse/fetch";
import type {
  FetchAndExtractResult,
  FetchMode,
  FetchSourceOptions,
  SnapshotStore,
} from "@kontourai/traverse/fetch";
import {
  extract,
  SHELL_WARNING_CODE,
  SHELL_WARNING_CODE_EMBEDDED,
  type EmbeddedState,
  type ExtractionProvider,
} from "@kontourai/traverse";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS } from "./traverse-schema";
import {
  buildTraverseItemProposalRecords,
  itemDisplayName,
  type TraverseItemProposalRecord,
} from "./traverse-extractor";
import { assembleItems, type AssembledItem } from "./traverse-item-grouping";
import { CAMPFIT_FETCH_USER_AGENT } from "./traverse-snapshot-store";
import type { IngestionSourceConfig } from "./sources";

/**
 * Sane default hard timeout for a single rendered source (~30s) — matches
 * the campfit-owned renderer module's own default constant of the same
 * name. Duplicated (not imported) as a deliberate, disclosed side effect of
 * AC7's fix: this file must no longer import that renderer module (or the
 * headless-browser test package it depends on) transitively at module
 * scope, since it is reachable from every Vercel route via
 * crawl-pipeline.ts (see the file doc's shell-detection-retry section).
 * Only scripts/scrape.ts's own import graph pulls that dependency in now.
 */
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/**
 * The review-sink seam. Given one item's traverse proposal record + which
 * source/snapshot it came from, persist it (in prod: resolve/anchor a
 * campId for the item and call `createProposal`) and return the created
 * proposal id. Injected so the routing is testable with no DB.
 */
export type TraverseProposalSink = (
  record: TraverseItemProposalRecord,
  meta: { sourceKey: string; sourceUrl: string; snapshotRef: string | null; snapshotBodyHash: string | null }
) => Promise<string | null>;

export interface TraversePipelineDeps {
  provider: ExtractionProvider;
  store: SnapshotStore;
  sink: TraverseProposalSink;
  /** fetch mode; default "live-with-capture" (prod). Tests/replay pass "replay". */
  mode?: FetchMode;
  /** injectable fetch/time seams forwarded to fetchSource — network-free tests. */
  fetchOptions?: FetchSourceOptions;
  /** override the fetch User-Agent (defaults to the honest CampFit bot UA). */
  userAgent?: string;
  /**
   * Resolver for each item's existing camp values, for scalar
   * populate-vs-update diffing. Called AFTER extraction with the actual item
   * display names for this source (so it can look up each by slug before
   * `buildTraverseItemProposalRecords` diffs against it).
   */
  currentByItemNames?: (
    sourceKey: string,
    itemNames: string[]
  ) => Promise<Map<string, Record<string, unknown>>> | Map<string, Record<string, unknown>>;
  /**
   * Optional extra per-field hints for THIS run's extraction call, merged
   * on top of the static `CAMP_FIELD_HINTS` (traverse-schema.ts) — e.g.
   * admin-authored `CrawlSiteHint` rows for the target domain
   * (`crawl-pipeline.ts`'s per-domain hint fetch, preserved by the per-camp
   * re-crawl adapter — see `lib/ingestion/traverse-recrawl-adapter.ts`).
   * Overlapping keys win over `CAMP_FIELD_HINTS`'s defaults; this never
   * REPLACES the static hints, only augments them for one run.
   */
  extraFieldHints?: Record<string, string>;
  /** content-prep truncation forwarded to extract(). */
  maxContentChars?: number;
  /**
   * Ceiling on `provider.extract()` calls issued for ONE source's page,
   * across every chunk `@kontourai/traverse`'s chunker splits it into
   * (`maxChunks` defaults to 40 — see `ExtractInput.maxChunks`). Forwarded to
   * `extract()` the same way `maxContentChars` is (an optional per-run
   * override this caller may set) — UNLIKE `maxContentChars`, though, when
   * this is left unset here it does NOT fall through to traverse's own
   * unbounded default: {@link DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE} applies
   * instead (see that constant's doc for the maxChunks=40 arithmetic
   * justifying the default). Set explicitly to override it (or pass a huge
   * number to effectively restore traverse's unbounded default).
   */
  maxProviderCalls?: number;
  /**
   * Ceiling on accumulated `raw.tokensUsed` for ONE source's page across
   * every chunk. Same forwarding/default-override relationship to
   * `maxContentChars` as {@link TraversePipelineDeps.maxProviderCalls} above
   * — see {@link DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE}'s doc for its default.
   */
  maxTotalTokens?: number;
  /** log sink; defaults to console.log. */
  log?: (msg: string) => void;
  /** wall-clock reader (ms), injectable for deterministic latency tests. */
  now?: () => number;
}

/**
 * Presence/counts of the embedded-state sidecar (@kontourai/traverse@0.6.0's
 * `ExtractionResult.embedded`) a source's page carried, when the DOWNGRADED
 * `js-shell-suspected-embedded-state-available` warning fired for it. Purely
 * telemetry: mapping the sidecar's contents onto proposals is a separate,
 * out-of-scope mapping/product decision — this just plumbs its presence
 * through so the owner can see which sources have it available.
 */
export interface TraverseEmbeddedStateInfo {
  /** number of `<script type="application/ld+json">` blocks harvested. */
  jsonLdCount: number;
  /** whether a Next.js `__NEXT_DATA__` payload was harvested. */
  hasNextData: boolean;
  /** whether a generic `__INITIAL_STATE__`/`__PRELOADED_STATE__` hydration blob was harvested. */
  hasInitialState: boolean;
}

/**
 * Records a NON-render source's automatic shell-detection retry (see the
 * file doc). Present only when the first attempt's extraction fired the pure
 * `js-shell-suspected` warning.
 */
export interface TraverseShellEscalation {
  /** the first attempt fired the pure (non-downgraded) js-shell-suspected warning. */
  shellDetected: true;
  /**
   * A render retry was actually ATTEMPTED. `false` in exactly one case
   * (campfit#53 spa-ingestion): `deps.fetchOptions?.renderImpl` was unset in
   * this execution context (every Vercel route today), so no retry could
   * possibly succeed — see `retrySkippedNoRenderer`. Otherwise always
   * `true` (mirrors this field's pre-#53 behavior).
   */
  renderRetried: boolean;
  /**
   * `true` when a render retry was SKIPPED entirely because no
   * `FetchSourceOptions.renderImpl` is configured in this execution
   * context — never issued, since it would only ever produce traverse's
   * `invalid-config` FetchError. Absent (not `false`) whenever a retry was
   * actually attempted (`renderRetried: true`), so this field's mere
   * presence unambiguously flags the "shell suspected, but this run has no
   * renderer at all" case for a caller (e.g. a future ingestion-report
   * classifier) without overloading `renderRetryFailed`, which is reserved
   * for a retry that WAS attempted and failed.
   */
  retrySkippedNoRenderer?: true;
  /** true when the render retry itself failed (fetch/timeout) — first attempt's results were kept. Always `false` when `renderRetried` is `false`. */
  renderRetryFailed: boolean;
  /** true when the retry grouped MORE items than the first attempt. Absent when the retry failed or was skipped. */
  renderImprovedProposalCount?: boolean;
  firstAttemptItemCount: number;
  firstAttemptWarnings: string[];
  /** Absent when the retry failed outright or was skipped (no extraction to count/report from). */
  retryAttemptItemCount?: number;
  retryAttemptWarnings?: string[];
}

export interface TraversePipelineSourceResult {
  source: string;
  url: string;
  /** true when fetch + extraction both completed without error (0 items is still ok). */
  ok: boolean;
  /** number of items (camps/courses/programs) traverse grouped out of this page. */
  itemCount: number;
  /** proposal ids the sink returned, one per routed item (null = sink no-op / not routed). */
  routedProposalIds: (string | null)[];
  /** total FieldDiff count across all routed items' proposedChanges. */
  routedFieldCount: number;
  /** snapshot-anchored provenance ref (traverse-snapshot:...), when captured. */
  snapshotRef: string | null;
  snapshotBodyHash: string | null;
  fetchError: string | null;
  extractionError: string | null;
  warnings: string[];
  /**
   * `ExtractionResult.totalTokensUsed` (traverse 0.8.0) — input+output tokens
   * SUMMED across every successful `provider.extract()` call this source's
   * page issued (one call per chunk on a multi-chunk page; see
   * `ExtractInput.maxChunks`, default 40). `null` only when there was no
   * extraction at all (fetch failure — see `fetchError`). Prior to this
   * field's adoption, this read `raw.tokensUsed` (the LAST chunk's response
   * only), which silently undercounted any page that chunked into more than
   * one provider call.
   */
  tokensUsed: number | null;
  /**
   * `ExtractionResult.providerCalls` (traverse 0.8.0) — number of
   * `provider.extract()` calls actually issued for this source's page
   * (attempted, success or throw; one per chunk, capped by
   * `maxProviderCalls` when set — see `TraversePipelineDeps.maxProviderCalls`).
   * `0` when there was no extraction at all (fetch failure).
   */
  providerCalls: number;
  /** model id the provider's raw response reported. */
  model: string | null;
  /** wall time (ms) for the fetch+extract call(s) — sums both attempts when a shell retry fires. */
  latencyMs: number;
  /**
   * Traverse's own honest, presence-is-the-marker render signal
   * (`Snapshot.rendered`, @kontourai/traverse@0.13.0's native rendered-fetch
   * seam — see docs/decisions/rendered-fetch.md in that package) — `true`
   * when this source's page was actually rendered via headless Chromium
   * (whether from `render: true` or from a shell-detection auto-retry), and
   * absent for a plain-fetched snapshot. Migrated off the pre-0.13.0
   * campfit-side `{durationMs, usedNetworkidleFallback}` telemetry shape
   * (campfit#53 spa-ingestion): this file no longer constructs the renderer
   * itself (the caller injects `FetchSourceOptions.renderImpl` — see AC7),
   * so it has no pipeline-owned side channel for that renderer-internal
   * telemetry anymore; `usedNetworkidleFallback` still surfaces, honestly,
   * as a `RenderResult.warnings` entry traverse merges into
   * `FetchResult.warnings` (see the campfit-owned renderer module's
   * `createCampfitRenderImpl`) — visible on `result.warnings`, not a
   * dedicated field here. A render
   * that timed out surfaces on `fetchError` — or, for a retry, on
   * `shellEscalation` — instead, with `rendered` absent, exactly like any
   * other fetch failure.
   */
  rendered?: true;
  /** see {@link TraverseShellEscalation}. Present only for a NON-render source whose first attempt looked like a JS shell. */
  shellEscalation?: TraverseShellEscalation;
  /** see {@link TraverseEmbeddedStateInfo}. Present only when the downgraded (embedded-state-available) shell warning fired. */
  embeddedStateAvailable?: TraverseEmbeddedStateInfo;
}

function summarizeEmbeddedState(embedded: EmbeddedState | undefined): TraverseEmbeddedStateInfo {
  return {
    jsonLdCount: embedded?.jsonLd?.length ?? 0,
    hasNextData: embedded?.nextData !== undefined,
    hasInitialState: embedded?.initialState !== undefined,
  };
}

/** Merge a per-run `deps.extraFieldHints` override on top of the static `CAMP_FIELD_HINTS` (see `TraversePipelineDeps.extraFieldHints`'s doc). */
function mergeFieldHints(deps: TraversePipelineDeps): Record<string, string> {
  if (!deps.extraFieldHints || Object.keys(deps.extraFieldHints).length === 0) return CAMP_FIELD_HINTS;
  return { ...CAMP_FIELD_HINTS, ...deps.extraFieldHints };
}

/**
 * Default ceiling on `provider.extract()` calls issued for ONE source's
 * page, applied by {@link runFetchAndExtractAttempt} whenever a caller
 * doesn't override `TraversePipelineDeps.maxProviderCalls`.
 *
 * Revised 2026-07 (code review, campfit#71 iteration 2 — see
 * docs/cutover-report-2026-07.md). The original default here was 20 (half of
 * `DEFAULT_MAX_CHUNKS`), chosen so the guard wasn't a no-op relative to the
 * chunker's own hard 40-chunk cap. That reasoning was sound in isolation,
 * but it meant introducing this cost guard silently CHANGED pipeline
 * behavior for any source that previously chunked into 21-40 calls and ran
 * to completion (the pre-cost-guard code had no ceiling besides `maxChunks`
 * itself) — such a source would now truncate at 20 with no operator-visible
 * trace. That's not this default's job: it exists as a RUNAWAY-SPEND
 * backstop, not a behavior-changing budget cut, so by default it must never
 * bind BELOW the ceiling that already existed before this feature
 * (`maxChunks`, 40).
 *
 * `maxChunks` (`ExtractInput.maxChunks`, @kontourai/traverse's chunk.ts) is
 * never overridden anywhere in this codebase today — `TraversePipelineDeps`
 * has no `maxChunks` field — so it always resolves to traverse's own
 * `DEFAULT_MAX_CHUNKS` (40), the HARD ceiling on how many chunks a single
 * page's chunker can even produce (extras are dropped with a warning before
 * any provider call happens). `chunks.length` can therefore never exceed 40,
 * and this constant is set TO that same 40: the in-loop check
 * (`providerCalls >= maxProviderCalls`, evaluated BEFORE each call) can only
 * ever become true once 40 calls have already been issued — i.e. only after
 * the 40-chunk hard cap has already fully run its course — so at this
 * default, the ceiling can never actually trip for any run today. It
 * re-activates as real, independent protection only if `maxChunks` itself is
 * ever raised above 40 (an upstream default bump, or a future `maxChunks`
 * seam added here). Operators who want a TIGHTER budget than the hard chunk
 * cap (e.g. to actually cut off a pathological/junk page before it reaches
 * 40 chunks) can still pass a lower `TraversePipelineDeps.maxProviderCalls`
 * explicitly — this default only guarantees the un-configured case matches
 * pre-cost-guard behavior (a pure backstop, never a silent truncation).
 */
export const DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE = 40;

/**
 * Default ceiling on accumulated `raw.tokensUsed` for ONE source's page,
 * applied by {@link runFetchAndExtractAttempt} whenever a caller doesn't
 * override `TraversePipelineDeps.maxTotalTokens`.
 *
 * Revised 2026-07 alongside {@link DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE}
 * (same review, same "pure backstop" rationale) — this must be raised in
 * lockstep so it doesn't become the FIRST thing to bind now that the
 * call-count default no longer can. Arithmetic, using the same
 * worst-case-per-call estimate as before: `maxContentChars` defaults to
 * 32_000 chars (`extract.ts`'s `DEFAULT_MAX_CONTENT_CHARS`, the PER-CHUNK
 * provider content budget) ≈ 8_000 tokens at the usual ~4-chars/token
 * estimate, plus the Anthropic adapter's own per-call OUTPUT budget, 2048
 * (`resolve-extraction-provider.ts`'s `DEFAULT_EXTRACTION_MAX_TOKENS`) — a
 * single worst-case call costs roughly 8_000 + 2_048 = 10_048 tokens. A FULL
 * 40-chunk run (the new `DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE`, and
 * traverse's own hard `maxChunks` cap) at that worst-case-per-call estimate
 * therefore costs roughly 40 * 10_048 = 401_920 tokens. Setting this
 * constant any lower than that would make IT the thing that truncates a
 * full-width 40-chunk run instead of the call-count ceiling above (defeating
 * the point of raising that one) — so this is set to 450_000, comfortably
 * above the 401_920 worst case (~12% headroom), while still acting as an
 * independent secondary trip-wire if a provider's real per-call token usage
 * runs higher than this content-budget-based estimate (e.g. a
 * verbose/non-English page with a worse chars-per-token ratio). Tighten via
 * `TraversePipelineDeps.maxTotalTokens` for an operator-chosen budget below
 * this backstop.
 */
export const DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE = 450_000;

/**
 * One fetch+extract call (an "attempt") — factored out so the shell-retry
 * seam can run it twice. `render` sets `SourceConfig.render` (traverse
 * 0.13.0's native rendered-fetch seam) for THIS attempt; `deps.fetchOptions`
 * (which may or may not carry a caller-injected `renderImpl` — see AC7) is
 * always forwarded unchanged, never swapped per-attempt: the render DECISION
 * lives on the source config now, not on which `fetch`/`renderImpl` gets
 * passed in. When `render` is true and `deps.fetchOptions?.renderImpl` is
 * unset, traverse itself surfaces a typed, non-throwing `invalid-config`
 * `FetchError` (rendered-fetch.md decision 1) — never a crash, never a
 * silent plain fetch.
 *
 * `renderTimeoutMs` (only meaningful when `render` is true) becomes
 * `SourceConfig.timeoutMs` — traverse forwards this value VERBATIM as the
 * `timeoutMs` HINT passed to `renderImpl` (rendered-fetch.md decision 2:
 * traverse does NOT wrap `renderImpl` in its own timeout race, unlike the
 * pre-0.13.0 `FetchLike` seam this migrated off of), so no doubled/padded
 * "outer traverse timeout vs. the renderer's own timeout" arithmetic is
 * needed anymore — the renderer enforces this value directly (see the
 * campfit-owned renderer module's `createCampfitRenderImpl`). `retries` is deliberately
 * left unset for a render attempt (not forced to `0`): traverse ignores
 * `SourceConfig.retries` for a rendered fetch regardless, and explicitly
 * SETTING it would trigger a "retries do not apply to a rendered fetch"
 * warning on every single render (decision 7) — noise this file never
 * wants for its own default render path.
 */
async function runFetchAndExtractAttempt(
  src: IngestionSourceConfig,
  deps: TraversePipelineDeps,
  render: boolean,
  renderTimeoutMs: number | undefined,
  now: () => number
): Promise<{ far: FetchAndExtractResult; latencyMs: number }> {
  const startedAt = now();
  const far = await fetchAndExtract(
    {
      id: src.key,
      url: src.url,
      contentType: "html",
      userAgent: deps.userAgent ?? CAMPFIT_FETCH_USER_AGENT,
      ...(render ? { render: true } : {}),
      ...(render && renderTimeoutMs !== undefined ? { timeoutMs: renderTimeoutMs } : {}),
    },
    {
      targetSchema: CAMP_TARGET_SCHEMA,
      fieldHints: mergeFieldHints(deps),
      provider: deps.provider,
      store: deps.store,
      mode: deps.mode ?? "live-with-capture",
      maxContentChars: deps.maxContentChars,
      // Real, non-unbounded defaults (unlike `maxContentChars` above) — see
      // DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE / DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE's
      // docs for the maxChunks=40 arithmetic. Covers both the scheduled
      // sweep (runTraversePipelineForSource) and the per-camp re-crawl
      // (runTraverseFetchAndAssemble / traverse-recrawl-adapter.ts) — both
      // funnel through this one attempt function.
      maxProviderCalls: deps.maxProviderCalls ?? DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE,
      maxTotalTokens: deps.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE,
      fetchOptions: deps.fetchOptions,
    }
  );
  return { far, latencyMs: now() - startedAt };
}

/** Shared source-result fields produced by fetch + the shell-detection auto-retry + extraction — every {@link TraversePipelineSourceResult} field EXCEPT the per-item routing fields (`itemCount`/`routedProposalIds`/`routedFieldCount`), which depend on what a caller does with `far.extraction.proposals` once grouped. */
type TraverseCoreFetchResult = Omit<TraversePipelineSourceResult, "itemCount" | "routedProposalIds" | "routedFieldCount">;

/**
 * Run one source through fetch + the shell-detection auto-retry (see the file
 * doc) and return the raw `FetchAndExtractResult` alongside every telemetry
 * field {@link TraverseCoreFetchResult} carries. Never throws: fetch and
 * extraction failures are surfaced on `core` (mirrors ingestion-runner.ts's
 * per-source isolation contract). Factored out of
 * `runTraversePipelineForSource` so a second caller
 * (`runTraverseFetchAndAssemble`, below) can reuse the identical fetch/retry
 * plumbing without also inheriting the per-item sink-routing shape that
 * function is built for.
 */
async function runCoreFetchAndExtract(
  src: IngestionSourceConfig,
  deps: TraversePipelineDeps
): Promise<{ far: FetchAndExtractResult; core: TraverseCoreFetchResult }> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? (() => Date.now());

  const core: TraverseCoreFetchResult = {
    source: src.key,
    url: src.url,
    ok: false,
    snapshotRef: null,
    snapshotBodyHash: null,
    fetchError: null,
    extractionError: null,
    warnings: [],
    tokensUsed: null,
    providerCalls: 0,
    model: null,
    latencyMs: 0,
  };

  // `render: true` (issue #41; native seam since @kontourai/traverse@0.13.0,
  // campfit#53): the render DECISION now lives on `SourceConfig.render`
  // (set per-attempt below), not on which `fetch`/`renderImpl` gets passed
  // in — `deps.fetchOptions` (which may or may not carry a caller-injected
  // `renderImpl`; see AC7) is forwarded unchanged to every attempt.
  // `renderTimeoutMs` becomes `SourceConfig.timeoutMs` for a render attempt,
  // which traverse forwards VERBATIM as the `timeoutMs` hint to `renderImpl`
  // (no doubled/padded outer-timeout arithmetic needed — see
  // `runFetchAndExtractAttempt`'s doc for why).
  const renderTimeoutMs = src.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;

  let totalLatencyMs = 0;
  const attempt1 = await runFetchAndExtractAttempt(
    src,
    deps,
    !!src.render,
    src.render ? renderTimeoutMs : undefined,
    now
  );
  totalLatencyMs += attempt1.latencyMs;
  let far = attempt1.far;

  // Shell-detection auto-retry (see the file doc). Only a NON-render source
  // is eligible — a `render: true` source is already rendered, so it never
  // re-enters this seam (never more than one render per source per run).
  if (!src.render && far.extraction) {
    const firstWarnings = far.extraction.warnings ?? [];
    const pureShellSuspected = firstWarnings.some((w) => w.startsWith(`${SHELL_WARNING_CODE}:`));
    const embeddedStateShellSuspected = firstWarnings.some((w) =>
      w.startsWith(`${SHELL_WARNING_CODE_EMBEDDED}:`)
    );

    if (embeddedStateShellSuspected) {
      core.embeddedStateAvailable = summarizeEmbeddedState(far.extraction.embedded);
      log(
        `[traverse-pipeline] ${src.key}: js-shell-suspected but embedded state is available ` +
          `(${core.embeddedStateAvailable.jsonLdCount} json-ld block(s)` +
          `${core.embeddedStateAvailable.hasNextData ? ", __NEXT_DATA__" : ""}` +
          `${core.embeddedStateAvailable.hasInitialState ? ", hydration state" : ""}) — skipping render`
      );
    }

    if (pureShellSuspected && !deps.fetchOptions?.renderImpl) {
      // No renderer configured in this execution context (every Vercel
      // route today — see AC7/Task 2.3): a `render: true` retry attempt
      // here would be doomed to traverse's own `invalid-config` FetchError,
      // wasting latency/log noise on every sweep run for a source that
      // trips the heuristic. Log the suspicion and move on with the first
      // attempt's (unrendered) results — never issue a retry we already
      // know cannot succeed.
      const firstAttemptItemCount = assembleItems(far.extraction.proposals).length;
      log(
        `[traverse-pipeline] ${src.key}: js-shell-suspected but no renderImpl is configured in this ` +
          `execution context — skipping the render retry (would fail invalid-config)`
      );
      core.shellEscalation = {
        shellDetected: true,
        renderRetried: false,
        retrySkippedNoRenderer: true,
        renderRetryFailed: false,
        firstAttemptItemCount,
        firstAttemptWarnings: firstWarnings,
      };
    } else if (pureShellSuspected) {
      const firstAttemptItemCount = assembleItems(far.extraction.proposals).length;
      log(`[traverse-pipeline] ${src.key}: js-shell-suspected — auto-retrying with a render`);

      const retryAttempt = await runFetchAndExtractAttempt(
        src,
        deps,
        true,
        renderTimeoutMs,
        now
      );
      totalLatencyMs += retryAttempt.latencyMs;

      const renderRetryFailed = retryAttempt.far.fetch.error !== undefined;
      if (renderRetryFailed) {
        // Render itself failed (timeout/network, or traverse's own
        // invalid-config if somehow reached) — partial (first-attempt)
        // results beat none: keep `far` as the first attempt and just note
        // the failed retry. `core.rendered` stays unset, exactly like any
        // other render that never completed.
        core.shellEscalation = {
          shellDetected: true,
          renderRetried: true,
          renderRetryFailed: true,
          firstAttemptItemCount,
          firstAttemptWarnings: firstWarnings,
          retryAttemptWarnings: retryAttempt.far.fetch.warnings ?? [],
        };
        log(
          `[traverse-pipeline] ${src.key}: render retry failed ` +
            `(${retryAttempt.far.fetch.error?.kind}: ${retryAttempt.far.fetch.error?.message}) — keeping first attempt's results`
        );
      } else {
        const retryAttemptItemCount = retryAttempt.far.extraction
          ? assembleItems(retryAttempt.far.extraction.proposals).length
          : 0;
        core.shellEscalation = {
          shellDetected: true,
          renderRetried: true,
          renderRetryFailed: false,
          renderImprovedProposalCount: retryAttemptItemCount > firstAttemptItemCount,
          firstAttemptItemCount,
          firstAttemptWarnings: firstWarnings,
          retryAttemptItemCount,
          retryAttemptWarnings: retryAttempt.far.extraction?.warnings ?? [],
        };
        // The retry is a strictly better read of the page (it rendered what
        // the first attempt only saw as a shell) — its results replace the
        // first attempt's for routing.
        far = retryAttempt.far;
      }
    }
  }

  core.latencyMs = totalLatencyMs;

  core.warnings.push(...(far.fetch.warnings ?? []));
  if (far.fetch.error) {
    core.fetchError = `${far.fetch.error.kind}: ${far.fetch.error.message}`;
  }
  if (far.fetch.snapshot) {
    core.snapshotRef = far.sourceRef ?? null;
    core.snapshotBodyHash = far.fetch.snapshot.bodyHash;
  }
  // traverse's own honest, presence-is-the-marker render signal (see
  // `TraversePipelineSourceResult.rendered`'s doc) — never inferred from
  // `src.render`/`shellEscalation` alone, only from the ACTUAL resolved
  // snapshot, so a render that traverse silently skipped (e.g. a future
  // config path this file doesn't yet know about) can never be
  // misreported as rendered.
  if (far.fetch.snapshot?.rendered) {
    core.rendered = true;
  }

  if (!far.extraction) {
    log(`[traverse-pipeline] ${src.key}: no extraction (${core.fetchError ?? "no snapshot"})`);
    return { far, core };
  }

  core.extractionError = far.extraction.error ?? null;
  core.warnings.push(...(far.extraction.warnings ?? []));
  // totalTokensUsed/providerCalls (traverse 0.8.0) are the SUMMED/counted
  // aggregates across every chunk's provider call — always populated,
  // never undefined, even on a zero-call early return. Reading
  // `raw.tokensUsed` here (pre-0.8.0) undercounted any multi-chunk page: it
  // is only the LAST chunk's response.
  core.tokensUsed = far.extraction.totalTokensUsed;
  core.providerCalls = far.extraction.providerCalls;
  core.model = far.extraction.raw?.model ?? null;
  core.ok = !core.extractionError;

  return { far, core };
}

/**
 * Run one source through the full pipeline: fetch + extract (via
 * {@link runCoreFetchAndExtract}), group into `AssembledItem`s
 * (traverse-item-grouping.ts), map EVERY item to a `ProposedChanges` review
 * record (traverse-extractor.ts's `itemToProposedChanges`, via
 * `buildTraverseItemProposalRecords`), and route each to the injected
 * `sink`. This is the "many items, create-if-new" shape `scripts/scrape.ts`
 * uses. Never throws: fetch and extraction failures are surfaced on the
 * result (mirrors ingestion-runner.ts's per-source isolation contract).
 *
 * NOT the shape a per-camp re-crawl of one already-known camp wants — see
 * {@link runTraverseFetchAndAssemble} below.
 */
export async function runTraversePipelineForSource(
  src: IngestionSourceConfig,
  deps: TraversePipelineDeps
): Promise<TraversePipelineSourceResult> {
  const log = deps.log ?? ((m: string) => console.log(m));

  const { far, core } = await runCoreFetchAndExtract(src, deps);
  const result: TraversePipelineSourceResult = { ...core, itemCount: 0, routedProposalIds: [], routedFieldCount: 0 };

  if (!far.extraction) {
    return result;
  }

  const itemNames = assembleItems(far.extraction.proposals).map((item) => itemDisplayName(item));
  const currentByItemName = deps.currentByItemNames
    ? await deps.currentByItemNames(src.key, itemNames)
    : undefined;
  const records = buildTraverseItemProposalRecords(far.extraction, {
    sourceUrl: far.fetch.snapshot?.url ?? src.url,
    currentByItemName,
  });
  result.itemCount = records.length;

  for (const record of records) {
    result.routedFieldCount += Object.keys(record.proposedChanges).length;
    const proposalId = await deps.sink(record, {
      sourceKey: src.key,
      sourceUrl: record.sourceUrl,
      snapshotRef: result.snapshotRef,
      snapshotBodyHash: result.snapshotBodyHash,
    });
    result.routedProposalIds.push(proposalId);
  }

  log(
    `[traverse-pipeline] ${src.key}: ${result.itemCount} item(s), ${result.routedFieldCount} field(s) routed to review ` +
      `(${result.routedProposalIds.filter((id) => id !== null).length} proposal(s) created)` +
      `${result.tokensUsed !== null ? `, ${result.tokensUsed} tokens` : ""}, ${result.latencyMs}ms` +
      `${result.snapshotBodyHash ? ` [snapshot ${result.snapshotBodyHash.slice(0, 12)}]` : ""}` +
      `${result.rendered ? ` [rendered]` : ""}` +
      `${result.shellEscalation ? ` [shell-suspected: ${
        result.shellEscalation.retrySkippedNoRenderer
          ? "no renderer configured, retry skipped"
          : result.shellEscalation.renderRetryFailed
            ? "render retry failed, kept first attempt"
            : `${result.shellEscalation.firstAttemptItemCount}->${result.shellEscalation.retryAttemptItemCount} item(s)`
      }]` : ""}`
  );
  return result;
}

/**
 * Result of {@link runTraverseFetchAndAssemble}: every
 * {@link TraverseCoreFetchResult} telemetry field, plus the raw grouped
 * `items` — WITHOUT diffing (`itemToProposedChanges`) or sink-routing any of
 * them. `items` is empty when fetch/extraction failed (see `ok`/`fetchError`/
 * `extractionError`).
 */
export interface TraverseCampFetchResult extends TraverseCoreFetchResult {
  /** every item traverse's per-item grouping found on the page, in item-index order. */
  items: AssembledItem[];
}

/**
 * Fetch + extract one source's page (via {@link runCoreFetchAndExtract}) and
 * group its proposals into `AssembledItem`s — WITHOUT routing anything to a
 * sink and WITHOUT diffing via `itemToProposedChanges`. This is the seam the
 * per-camp re-crawl adapter (`lib/ingestion/traverse-recrawl-adapter.ts`)
 * uses instead of `runTraversePipelineForSource`: a re-crawl of one
 * already-known camp needs the raw candidate items so IT can select (never
 * guess/name-match against the whole DB the way `currentByItemNames` does)
 * the one item that is THIS camp, then diff it itself via `diff-engine.ts`'s
 * `computeDiff` — not `itemToProposedChanges`, which has no confidence
 * floor, suppression, or additive-array logic (traverse-recrawl-cutover
 * plan, Task 1.3 / Stop-short risk 5). Never throws.
 */
export async function runTraverseFetchAndAssemble(
  src: IngestionSourceConfig,
  deps: TraversePipelineDeps
): Promise<TraverseCampFetchResult> {
  const { far, core } = await runCoreFetchAndExtract(src, deps);
  if (!far.extraction) {
    return { ...core, items: [] };
  }
  return { ...core, items: assembleItems(far.extraction.proposals) };
}

/**
 * Route every configured source through {@link runTraversePipelineForSource}
 * with per-source isolation (one source's failure never stops the next).
 */
export async function runTraversePipeline(
  sources: IngestionSourceConfig[],
  deps: TraversePipelineDeps
): Promise<TraversePipelineSourceResult[]> {
  const out: TraversePipelineSourceResult[] = [];
  for (const src of sources) {
    out.push(await runTraversePipelineForSource(src, deps));
  }
  return out;
}
