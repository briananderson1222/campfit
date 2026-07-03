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
}

export const INGESTION_SOURCES: IngestionSourceConfig[] = [
  { key: "avid4", name: "Avid4 Adventure", url: "https://avid4.com/day-camps/colorado/" },
  { key: "denver-art-museum", name: "Denver Art Museum", url: "https://www.denverartmuseum.org/en/summer-camps" },
  { key: "idtech", name: "iD Tech", url: "https://www.idtech.com/courses" },
];
