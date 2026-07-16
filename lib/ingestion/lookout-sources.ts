import type { TargetFieldSchema } from "@kontourai/traverse";
import type { LookoutSource, RenderPolicy } from "@kontourai/lookout";
import { CAMP_TARGET_SCHEMA } from "./traverse-schema";
import { DISCOVERY_TARGET_SCHEMA } from "./discovery-schema";
import type { Camp } from "@/lib/types";
import type { IngestionSourceConfig } from "./sources";

export const LOOKOUT_CADENCE_HINT = "scheduled-crawl";
export const DISCOVERY_SOURCE_PREFIX = "campfit-discovery:";

export function discoverySourceId(url: string): string { return `${DISCOVERY_SOURCE_PREFIX}${url}`; }

export function campToLookoutSource(camp: Pick<Camp, "id" | "websiteUrl">, renderPolicy: RenderPolicy = "never"): LookoutSource {
  return source(camp.id, camp.websiteUrl, CAMP_TARGET_SCHEMA, renderPolicy);
}

export function listingToLookoutSource(url: string, options: { cadenceHint?: string; renderPolicy?: RenderPolicy } = {}): LookoutSource {
  return source(discoverySourceId(url), url, DISCOVERY_TARGET_SCHEMA, options.renderPolicy ?? "on-shell-warning", options.cadenceHint);
}

/**
 * Sources-strategy drift gate (campfit#134): a `LookoutSource` keyed by an
 * `IngestionSourceConfig`'s own stable `key` (e.g. `agg:camperoni:<slug>` —
 * `sourceKey()` in `scripts/crawl-aggregator-providers.ts`), NOT
 * `discoverySourceId(url)` (that identity belongs to the discovery-listing
 * path above, a different Lookout source lineage). Targets `CAMP_TARGET_SCHEMA`
 * (the per-item camp/program schema) since a provider source page is a
 * multi-item listing extracted the same way `runTraversePipelineForSource`
 * already does — not the discovery placeholder schema. Used by
 * `crawl-pipeline.ts`'s opt-in `CrawlOptions.driftGate` to run a Lookout CHECK
 * before extracting a sources-strategy source's page.
 */
export function providerSourceToLookoutSource(src: IngestionSourceConfig, renderPolicy: RenderPolicy = "on-shell-warning"): LookoutSource {
  return source(src.key, src.url, CAMP_TARGET_SCHEMA, renderPolicy);
}

function source(id: string, url: string, targetSchema: TargetFieldSchema[], renderPolicy: RenderPolicy, cadenceHint = LOOKOUT_CADENCE_HINT): LookoutSource {
  return { id, url, kind: "web-page", targetSchema, cadenceHint, renderPolicy };
}
