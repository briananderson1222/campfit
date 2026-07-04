/**
 * lib/ingestion/discovery/types.ts — the discovery-source contract (I22 / #52).
 *
 * Discovery is the INGESTION-SIDE intake step that finds *new providers* for a
 * metro and lands them as candidates in a human review queue. It is distinct
 * from the traverse crawl pipeline (lib/ingestion/traverse-pipeline.ts), which
 * extracts camp *fields* for providers that already exist. A discovered
 * provider, once a human approves the candidate, becomes a real Provider row
 * that the crawl pipeline then picks up (this is the "feeds #50 / I20" edge).
 *
 * A DiscoverySource is deliberately narrow: `discover()` returns a flat list of
 * raw provider candidates plus the provenance every candidate must carry (R4).
 * The shipped source (sources/denver-rec-centers.ts) is a curated seed — the
 * "curated seed query" flavor the issue's thinnest slice names — so the job is
 * deterministic and key-free in CI. A live-page source (a rec-center program
 * listing that needs fetch+extraction; issue I23) implements the SAME interface
 * and can drive the traverse pipeline inside its own `discover()`; nothing in
 * the runner/dedupe/queue below changes when that source is added.
 */

/** One raw provider candidate as a discovery source surfaces it, pre-dedupe. */
export interface RawProviderCandidate {
  /** Provider/organization name as the source presents it. */
  name: string;
  /** Homepage / program-listing URL, if the source has one. */
  websiteUrl: string | null;
  /** Municipality the provider operates in — drives the metro-boundary filter. */
  city: string | null;
  /** Optional finer-grained locality. */
  neighborhood?: string | null;
}

/** The result of running one discovery source once, with shared provenance. */
export interface DiscoverySourceResult {
  candidates: RawProviderCandidate[];
  /** The listing/query string that produced these candidates (R4 provenance). */
  discoveryQuery: string;
  /** When the candidates were retrieved from the source (R4 provenance). */
  retrievedAt: Date;
}

/** A pluggable discovery source. One concrete source ships today; more later. */
export interface DiscoverySource {
  /** Stable machine key — recorded on every candidate as `sourceKey`. */
  key: string;
  /** Human-readable label — recorded on every candidate as `sourceLabel`. */
  label: string;
  /** Metro/community this source is scoped to. Denver-only for now (hard boundary). */
  communitySlug: string;
  discover(): Promise<DiscoverySourceResult>;
}
