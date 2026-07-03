/**
 * traverse-ingestion.ts — the FLAGGED traverse ingestion path (Slice 2b).
 *
 * When the `TRAVERSE_INGESTION` flag is on (see {@link isTraverseIngestionEnabled}),
 * the scrape pipeline routes the SELECTOR-DEAD sources (avid4, denver-art-museum)
 * through schema-directed traverse extraction instead of their rotted CSS-selector
 * path, and feeds the resulting provenance-bearing proposals into the EXISTING
 * human-review sink (`createProposal`, via `buildTraverseProposalRecord`) — never a
 * direct write (ADR 0003 discipline). The legacy scraper still runs in SHADOW so its
 * (currently 0) camp count is logged next to the traverse proposal count for
 * comparison telemetry.
 *
 * Design:
 *  - This module owns ONLY the flag gate + the fetch→extract→build-record→sink
 *    routing. It never touches the DB itself; the `sink` is injected, so the
 *    whole path is exercised in CI with a stub provider, an in-memory snapshot
 *    store, an injected network-free `fetch`, and a fake sink (see
 *    scripts/test-traverse-replay.ts). The real scrape wiring (scripts/scrape.ts)
 *    passes a sink that resolves a campId + crawlRunId and calls `createProposal`.
 *  - Fetch is `live-with-capture` by default: every extraction is captured to the
 *    snapshot store so each proposal is traceable to byte-identical bytes and a
 *    future run can replay (`mode: "replay"`).
 *  - Flag OFF => this module is never entered; default scrape behavior is
 *    byte-identical to before.
 *  - Healthy sources are NOT in {@link ROTTED_SOURCE_KEYS} and are untouched by
 *    the flag in this slice.
 */

import { fetchAndExtract } from "@kontourai/traverse/fetch";
import type {
  FetchMode,
  FetchSourceOptions,
  SnapshotStore,
} from "@kontourai/traverse/fetch";
import type { ExtractionProvider } from "@kontourai/traverse";
import { BaseScraper } from "./scraper-base";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS } from "./traverse-schema";
import {
  buildTraverseProposalRecord,
  type TraverseProposalRecord,
} from "./traverse-extractor";
import { CAMPFIT_FETCH_USER_AGENT } from "./traverse-snapshot-store";

/** The env flag that turns the traverse ingestion path on for rotted sources. */
export const TRAVERSE_INGESTION_FLAG = "TRAVERSE_INGESTION";

/**
 * The selector-dead sources this slice routes through traverse when the flag is
 * on. Keyed by the scraper's stable source key. Healthy sources (e.g. idtech)
 * are deliberately absent — the flag does not touch them in this slice.
 */
export const ROTTED_SOURCE_KEYS = new Set<string>(["avid4", "denver-art-museum"]);

/** True when `TRAVERSE_INGESTION` is set to a truthy value ("1"/"true"/"on"/"yes"). */
export function isTraverseIngestionEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[TRAVERSE_INGESTION_FLAG];
  if (!raw) return false;
  return ["1", "true", "on", "yes"].includes(raw.trim().toLowerCase());
}

/** Is this source one the flag routes through traverse (vs. legacy selectors)? */
export function isRottedSource(key: string): boolean {
  return ROTTED_SOURCE_KEYS.has(key);
}

/** A source to (shadow-)scrape legacy and route through traverse. */
export interface TraverseIngestionSource {
  /** stable source key, e.g. "avid4". Must be in ROTTED_SOURCE_KEYS to route. */
  key: string;
  /** entry URL to fetch + extract. */
  url: string;
  /** the legacy scraper, run in shadow purely for count telemetry. */
  scraper: BaseScraper;
}

/**
 * The review-sink seam. Given a traverse proposal record + which source/snapshot
 * it came from, persist it (in prod: resolve a campId + crawlRunId and call
 * `createProposal`) and return the created proposal id. Injected so the routing
 * is testable with no DB.
 */
export type TraverseProposalSink = (
  record: TraverseProposalRecord,
  meta: { sourceKey: string; sourceUrl: string; snapshotRef: string | null }
) => Promise<string | null>;

export interface TraverseIngestionDeps {
  provider: ExtractionProvider;
  store: SnapshotStore;
  sink: TraverseProposalSink;
  /** fetch mode; default "live-with-capture" (prod). Tests may pass "replay". */
  mode?: FetchMode;
  /** injectable fetch/time seams forwarded to fetchSource — network-free tests. */
  fetchOptions?: FetchSourceOptions;
  /** override the fetch User-Agent (defaults to the honest CampFit bot UA). */
  userAgent?: string;
  /** current camp values, for scalar populate-vs-update diffing in the record. */
  current?: Record<string, unknown>;
  /** content-prep truncation forwarded to extract(). */
  maxContentChars?: number;
  /** log sink; defaults to console.log. */
  log?: (msg: string) => void;
}

export interface TraverseIngestionSourceResult {
  source: string;
  /** legacy scraper camp count (shadow run) — comparison telemetry. */
  legacyShadowCount: number;
  legacyShadowError: string | null;
  /** number of surviving traverse proposals routed into the record. */
  traverseProposalCount: number;
  /** number of FieldDiffs in the routed ProposedChanges map. */
  routedFieldCount: number;
  /** the proposal id the sink returned (null if nothing routed / sink no-op). */
  routedProposalId: string | null;
  /** snapshot-anchored provenance ref (traverse-snapshot:...), when captured. */
  snapshotRef: string | null;
  snapshotBodyHash: string | null;
  fetchError: string | null;
  extractionError: string | null;
  warnings: string[];
}

/**
 * Route one selector-dead source through traverse into the review sink, running
 * the legacy scraper in shadow for count telemetry. Never throws: fetch and
 * extraction failures are surfaced on the result (mirrors scrape-runner's
 * per-source isolation contract).
 */
export async function runTraverseIngestionForSource(
  src: TraverseIngestionSource,
  deps: TraverseIngestionDeps
): Promise<TraverseIngestionSourceResult> {
  const log = deps.log ?? ((m: string) => console.log(m));

  // 1. Legacy scraper in SHADOW — count only, never written; never throws.
  let legacyShadowCount = 0;
  let legacyShadowError: string | null = null;
  try {
    const legacy = await src.scraper.run();
    legacyShadowCount = legacy.camps.length;
    legacyShadowError = legacy.errors[0] ?? null;
  } catch (e) {
    legacyShadowError = e instanceof Error ? e.message : String(e);
  }

  const result: TraverseIngestionSourceResult = {
    source: src.key,
    legacyShadowCount,
    legacyShadowError,
    traverseProposalCount: 0,
    routedFieldCount: 0,
    routedProposalId: null,
    snapshotRef: null,
    snapshotBodyHash: null,
    fetchError: null,
    extractionError: null,
    warnings: [],
  };

  // 2. Fetch WITH capture + extract in one call (provenance continuity).
  const far = await fetchAndExtract(
    {
      id: src.key,
      url: src.url,
      contentType: "html",
      userAgent: deps.userAgent ?? CAMPFIT_FETCH_USER_AGENT,
    },
    {
      targetSchema: CAMP_TARGET_SCHEMA,
      fieldHints: CAMP_FIELD_HINTS,
      provider: deps.provider,
      store: deps.store,
      mode: deps.mode ?? "live-with-capture",
      maxContentChars: deps.maxContentChars,
      fetchOptions: deps.fetchOptions,
    }
  );

  result.warnings.push(...(far.fetch.warnings ?? []));
  if (far.fetch.error) {
    result.fetchError = `${far.fetch.error.kind}: ${far.fetch.error.message}`;
  }
  if (far.fetch.snapshot) {
    result.snapshotRef = far.sourceRef ?? null;
    result.snapshotBodyHash = far.fetch.snapshot.bodyHash;
  }

  if (!far.extraction) {
    log(
      `[traverse-ingestion] ${src.key}: legacy(shadow)=${legacyShadowCount} camps, ` +
        `no extraction (${result.fetchError ?? "no snapshot"})`
    );
    return result;
  }

  result.extractionError = far.extraction.error ?? null;
  result.warnings.push(...(far.extraction.warnings ?? []));
  result.traverseProposalCount = far.extraction.proposals.length;

  // 3. Build the createProposal-shaped record and route it to the review sink.
  if (far.extraction.proposals.length > 0) {
    const record = buildTraverseProposalRecord(
      far.extraction,
      deps.current ?? {},
      far.fetch.snapshot?.url ?? src.url
    );
    result.routedFieldCount = Object.keys(record.proposedChanges).length;
    result.routedProposalId = await deps.sink(record, {
      sourceKey: src.key,
      sourceUrl: record.sourceUrl,
      snapshotRef: result.snapshotRef,
    });
  }

  log(
    `[traverse-ingestion] ${src.key}: legacy(shadow)=${legacyShadowCount} camps, ` +
      `traverse=${result.traverseProposalCount} proposals (${result.routedFieldCount} fields) ` +
      `routed to review${result.routedProposalId ? ` (proposal ${result.routedProposalId})` : ""}` +
      `${result.snapshotBodyHash ? ` [snapshot ${result.snapshotBodyHash.slice(0, 12)}]` : ""}`
  );
  return result;
}

/**
 * Route every given selector-dead source through {@link runTraverseIngestionForSource}
 * with per-source isolation (one source's failure never stops the next).
 */
export async function runTraverseIngestion(
  sources: TraverseIngestionSource[],
  deps: TraverseIngestionDeps
): Promise<TraverseIngestionSourceResult[]> {
  const out: TraverseIngestionSourceResult[] = [];
  for (const src of sources) {
    out.push(await runTraverseIngestionForSource(src, deps));
  }
  return out;
}
