import type { TargetFieldSchema } from "@kontourai/traverse";
import type { LookoutSource, RenderPolicy } from "@kontourai/lookout";
import { CAMP_TARGET_SCHEMA } from "./traverse-schema";
import { DISCOVERY_TARGET_SCHEMA } from "./discovery-schema";
import type { Camp } from "@/lib/types";
import type { IngestionSourceConfig } from "./sources";

export const LOOKOUT_CADENCE_HINT = "scheduled-crawl";
export const DISCOVERY_SOURCE_PREFIX = "campfit-discovery:";

/** The source id Traverse's live discovery fetch writes a listing's captures under. */
export function discoverySourceId(url: string): string { return `${DISCOVERY_SOURCE_PREFIX}${url}`; }

/**
 * Lookout's captures live in the same snapshot store as Traverse's, under
 * source ids no Traverse fetcher writes. Lookout compares each fetch with the
 * latest capture under its source id, so a Traverse capture under that id
 * would become the prior: a capture Traverse hashed over decoded text makes
 * every later check `changed`, and a Traverse capture of new content between
 * two checks would let the second report `unchanged` against content no
 * observation was ever made of. The same store is kept (not a separate one)
 * because review, apply and attestation resolve a proposal's snapshot
 * reference through `createCampfitSnapshotStore()`, and a Lookout-path
 * proposal cites the Lookout capture it was replayed from.
 *
 * Changing these ids started a new Lookout history: observations and
 * captures recorded under the old ids stay where they are and still read,
 * but the next check of each source establishes a new baseline.
 */
export const LOOKOUT_SOURCE_PREFIX = "lookout:";

/** The Lookout source id for the Traverse source id `traverseSourceId`. */
export function lookoutSourceId(traverseSourceId: string): string { return `${LOOKOUT_SOURCE_PREFIX}${traverseSourceId}`; }

export function campToLookoutSource(camp: Pick<Camp, "id" | "websiteUrl">, renderPolicy: RenderPolicy = "never"): LookoutSource {
  return source(lookoutSourceId(camp.id), camp.websiteUrl, CAMP_TARGET_SCHEMA, renderPolicy);
}

export function listingToLookoutSource(url: string, options: { cadenceHint?: string; renderPolicy?: RenderPolicy } = {}): LookoutSource {
  return source(lookoutSourceId(discoverySourceId(url)), url, DISCOVERY_TARGET_SCHEMA, options.renderPolicy ?? "on-shell-warning", options.cadenceHint);
}

/**
 * Sources-strategy drift gate (campfit#134): a `LookoutSource` keyed by
 * `lookoutSourceId()` of an `IngestionSourceConfig`'s own stable `key` (e.g.
 * `agg:camperoni:<slug>` — `sourceKey()` in
 * `scripts/crawl-aggregator-providers.ts`), NOT the listing id above (a
 * different Lookout source lineage). `runTraversePipelineForSource` writes its
 * live captures under the bare `key`, so the two never share a history. Targets `CAMP_TARGET_SCHEMA`
 * (the per-item camp/program schema) since a provider source page is a
 * multi-item listing extracted the same way `runTraversePipelineForSource`
 * already does — not the discovery placeholder schema. Used by
 * `crawl-pipeline.ts`'s opt-in `CrawlOptions.driftGate` to run a Lookout CHECK
 * before extracting a sources-strategy source's page.
 */
export function providerSourceToLookoutSource(src: IngestionSourceConfig, renderPolicy: RenderPolicy = "on-shell-warning"): LookoutSource {
  return source(lookoutSourceId(src.key), src.url, CAMP_TARGET_SCHEMA, renderPolicy);
}

function source(id: string, url: string, targetSchema: TargetFieldSchema[], renderPolicy: RenderPolicy, cadenceHint = LOOKOUT_CADENCE_HINT): LookoutSource {
  return { id, url, kind: "web-page", targetSchema, cadenceHint, renderPolicy };
}
