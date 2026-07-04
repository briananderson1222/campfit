/**
 * lib/ingestion/discovery/index.ts — the discovery-source registry (I22 / #52).
 *
 * Mirrors lib/ingestion/sources.ts's INGESTION_SOURCES pattern: a flat registry
 * the CLI resolves a `--source` key against. One curated source ships today;
 * live-page sources (I23) register here by adding an entry.
 */
import { denverRecCenterSource } from "./sources/denver-rec-centers";
import type { DiscoverySource } from "./types";

export const DISCOVERY_SOURCES: DiscoverySource[] = [denverRecCenterSource];

export function getDiscoverySource(key: string): DiscoverySource | undefined {
  return DISCOVERY_SOURCES.find((s) => s.key === key);
}

export const DEFAULT_DISCOVERY_SOURCE_KEY = denverRecCenterSource.key;

export * from "./types";
export * from "./runner";
export * from "./candidate-repository";
