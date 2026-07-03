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
 *    records `tokensUsed` (from the provider's raw response — the Anthropic
 *    adapter reports `input_tokens + output_tokens`) and `latencyMs` (wall
 *    time for the fetch+extract call), so model/provider choice is a
 *    data-backed decision (see docs/cutover-report-2026-07.md).
 */

import { fetchAndExtract } from "@kontourai/traverse/fetch";
import type {
  FetchMode,
  FetchSourceOptions,
  SnapshotStore,
} from "@kontourai/traverse/fetch";
import type { ExtractionProvider } from "@kontourai/traverse";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS } from "./traverse-schema";
import {
  buildTraverseItemProposalRecords,
  itemDisplayName,
  type TraverseItemProposalRecord,
} from "./traverse-extractor";
import { assembleItems } from "./traverse-item-grouping";
import { CAMPFIT_FETCH_USER_AGENT } from "./traverse-snapshot-store";
import type { IngestionSourceConfig } from "./sources";
import { createRenderFetchLike, DEFAULT_RENDER_TIMEOUT_MS, type RenderResult } from "./render-fetch";

// TODO(#41 follow-up, blocked on kontourai/traverse#11): today `render` is an
// explicit per-source opt-in (IngestionSourceConfig.render). Once traverse's
// JS-shell-detection warning (kontourai/traverse#11: "content looks like a
// JS-rendered shell — render and retry") lands, this is the place to
// auto-retry a NON-render source with rendering when that warning fires on
// its extraction, and record the escalation on the result (alongside the
// `render` telemetry below) rather than requiring every JS-heavy source to
// be curated by hand up front.

/**
 * The review-sink seam. Given one item's traverse proposal record + which
 * source/snapshot it came from, persist it (in prod: resolve/anchor a
 * campId for the item and call `createProposal`) and return the created
 * proposal id. Injected so the routing is testable with no DB.
 */
export type TraverseProposalSink = (
  record: TraverseItemProposalRecord,
  meta: { sourceKey: string; sourceUrl: string; snapshotRef: string | null }
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
  /** content-prep truncation forwarded to extract(). */
  maxContentChars?: number;
  /** log sink; defaults to console.log. */
  log?: (msg: string) => void;
  /** wall-clock reader (ms), injectable for deterministic latency tests. */
  now?: () => number;
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
  /** input+output tokens the provider reported for this source's single extraction call. */
  tokensUsed: number | null;
  /** model id the provider's raw response reported. */
  model: string | null;
  /** wall time (ms) for the fetch+extract call. */
  latencyMs: number;
  /**
   * Render telemetry (see lib/ingestion/render-fetch.ts) — present only
   * when this source has `render: true` AND the render itself completed
   * (a render that timed out surfaces on `fetchError` instead, with no
   * telemetry, exactly like any other fetch failure).
   */
  render?: { durationMs: number; usedNetworkidleFallback: boolean };
}

/**
 * Run one source through the full pipeline. Never throws: fetch and
 * extraction failures are surfaced on the result (mirrors
 * ingestion-runner.ts's per-source isolation contract).
 */
export async function runTraversePipelineForSource(
  src: IngestionSourceConfig,
  deps: TraversePipelineDeps
): Promise<TraversePipelineSourceResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? (() => Date.now());

  const result: TraversePipelineSourceResult = {
    source: src.key,
    url: src.url,
    ok: false,
    itemCount: 0,
    routedProposalIds: [],
    routedFieldCount: 0,
    snapshotRef: null,
    snapshotBodyHash: null,
    fetchError: null,
    extractionError: null,
    warnings: [],
    tokensUsed: null,
    model: null,
    latencyMs: 0,
  };

  // `render: true` (issue #41): swap the injected FetchLike for a
  // headless-Chromium render instead of a plain HTTP GET, and give
  // `fetchSource` a generous outer timeoutMs + zero retries so its own
  // AbortController/retry loop doesn't fight (or triple) renderPage()'s own
  // hard, two-attempt timeout budget (see render-fetch.ts). Any other
  // injected fetchOptions (e.g. a test's `sleep`/`politenessState`) are
  // preserved; only `fetch` is overridden.
  const renderTimeoutMs = src.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const fetchOptions: FetchSourceOptions | undefined = src.render
    ? {
        ...deps.fetchOptions,
        fetch: createRenderFetchLike({
          timeoutMs: renderTimeoutMs,
          onRendered: (info: RenderResult) => {
            result.render = { durationMs: info.durationMs, usedNetworkidleFallback: info.usedNetworkidleFallback };
          },
        }),
      }
    : deps.fetchOptions;

  const startedAt = now();
  const far = await fetchAndExtract(
    {
      id: src.key,
      url: src.url,
      contentType: "html",
      userAgent: deps.userAgent ?? CAMPFIT_FETCH_USER_AGENT,
      ...(src.render ? { timeoutMs: renderTimeoutMs * 2 + 5_000, retries: 0 } : {}),
    },
    {
      targetSchema: CAMP_TARGET_SCHEMA,
      fieldHints: CAMP_FIELD_HINTS,
      provider: deps.provider,
      store: deps.store,
      mode: deps.mode ?? "live-with-capture",
      maxContentChars: deps.maxContentChars,
      fetchOptions,
    }
  );
  result.latencyMs = now() - startedAt;

  result.warnings.push(...(far.fetch.warnings ?? []));
  if (far.fetch.error) {
    result.fetchError = `${far.fetch.error.kind}: ${far.fetch.error.message}`;
  }
  if (far.fetch.snapshot) {
    result.snapshotRef = far.sourceRef ?? null;
    result.snapshotBodyHash = far.fetch.snapshot.bodyHash;
  }

  if (!far.extraction) {
    log(`[traverse-pipeline] ${src.key}: no extraction (${result.fetchError ?? "no snapshot"})`);
    return result;
  }

  result.extractionError = far.extraction.error ?? null;
  result.warnings.push(...(far.extraction.warnings ?? []));
  result.tokensUsed = far.extraction.raw?.tokensUsed ?? null;
  result.model = far.extraction.raw?.model ?? null;
  result.ok = !result.extractionError;

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
    });
    result.routedProposalIds.push(proposalId);
  }

  log(
    `[traverse-pipeline] ${src.key}: ${result.itemCount} item(s), ${result.routedFieldCount} field(s) routed to review ` +
      `(${result.routedProposalIds.filter((id) => id !== null).length} proposal(s) created)` +
      `${result.tokensUsed !== null ? `, ${result.tokensUsed} tokens` : ""}, ${result.latencyMs}ms` +
      `${result.snapshotBodyHash ? ` [snapshot ${result.snapshotBodyHash.slice(0, 12)}]` : ""}` +
      `${result.render ? ` [rendered in ${result.render.durationMs}ms${result.render.usedNetworkidleFallback ? ", networkidle→domcontentloaded fallback" : ""}]` : ""}`
  );
  return result;
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
