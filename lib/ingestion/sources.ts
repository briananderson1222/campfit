/**
 * sources.ts — the registry of ingestion sources for the traverse pipeline.
 *
 * FULL CUTOVER (owner directive, 2026-07): traverse is now THE ingestion
 * pipeline for every source — there is no more CSS-selector-scraper
 * registry (lib/ingestion/scrapers/*.ts, deleted) and no more
 * TRAVERSE_INGESTION flag/rotted-source split. Every source here is fetched
 * + extracted the same way (lib/ingestion/traverse-pipeline.ts): fetch with
 * snapshot capture -> schema-directed per-item extraction -> route each
 * item to the review sink.
 */

export interface IngestionSourceConfig {
  /** stable, machine-friendly key — used for snapshot store identity + reporting. */
  key: string;
  /** human-readable name for logging/reports. */
  name: string;
  /** entry URL to fetch. */
  url: string;
  /**
   * When true, this source's page is fetched via a headless-Chromium render
   * instead of a plain HTTP GET — for JS-rendered SPA sources whose plain
   * fetch returns an empty shell. Traverse 0.13.0's native rendered-fetch
   * seam (`SourceConfig.render` + `FetchSourceOptions.renderImpl` — issue
   * #41, campfit#53 spa-ingestion; see
   * docs/decisions/spa-rendered-provider-pages.md): this flag alone does
   * NOT render anything — the caller must ALSO configure
   * `TraversePipelineDeps.fetchOptions.renderImpl`
   * (`lib/ingestion/render-fetch.ts`'s `createCampfitRenderImpl()`, wired
   * only into `scripts/scrape.ts`'s GitHub Actions execution context, the
   * only place a headless browser can launch today). Off by default; the
   * rendered HTML flows into the SAME fetch->extract pipeline as a plain
   * fetch, honestly marked `Snapshot.rendered: true`. No source enables this
   * yet — it's a per-source curation decision made once a source is
   * confirmed to need it (see docs/traverse-ingestion.md). For a
   * provider-triggered per-camp recrawl instead of a curated sweep source,
   * see `Provider.requiresRender` (migration 019) in
   * `lib/ingestion/traverse-recrawl-adapter.ts`.
   */
  render?: boolean;
  /**
   * Hard per-attempt render timeout (ms). Only consulted when `render` is
   * true — becomes `SourceConfig.timeoutMs`, which traverse forwards
   * verbatim as the `timeoutMs` hint passed to `renderImpl`. Defaults to
   * `lib/ingestion/render-fetch.ts`'s `DEFAULT_RENDER_TIMEOUT_MS` (~30s).
   */
  renderTimeoutMs?: number;
}

export const INGESTION_SOURCES: IngestionSourceConfig[] = [
  { key: "avid4", name: "Avid4 Adventure", url: "https://avid4.com/day-camps/colorado/" },
  { key: "denver-art-museum", name: "Denver Art Museum", url: "https://www.denverartmuseum.org/en/summer-camps" },
  { key: "idtech", name: "iD Tech", url: "https://www.idtech.com/courses" },
];
