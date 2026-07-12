import type { TargetFieldSchema } from "@kontourai/traverse";
import type { LookoutSource, RenderPolicy } from "@kontourai/lookout";
import { CAMP_TARGET_SCHEMA } from "./traverse-schema";
import { DISCOVERY_TARGET_SCHEMA } from "./discovery-schema";
import type { Camp } from "@/lib/types";

export const LOOKOUT_CADENCE_HINT = "scheduled-crawl";
export const DISCOVERY_SOURCE_PREFIX = "campfit-discovery:";

export function discoverySourceId(url: string): string { return `${DISCOVERY_SOURCE_PREFIX}${url}`; }

export function campToLookoutSource(camp: Pick<Camp, "id" | "websiteUrl">, renderPolicy: RenderPolicy = "never"): LookoutSource {
  return source(camp.id, camp.websiteUrl, CAMP_TARGET_SCHEMA, renderPolicy);
}

export function listingToLookoutSource(url: string, options: { cadenceHint?: string; renderPolicy?: RenderPolicy } = {}): LookoutSource {
  return source(discoverySourceId(url), url, DISCOVERY_TARGET_SCHEMA, options.renderPolicy ?? "on-shell-warning", options.cadenceHint);
}

function source(id: string, url: string, targetSchema: TargetFieldSchema[], renderPolicy: RenderPolicy, cadenceHint = LOOKOUT_CADENCE_HINT): LookoutSource {
  return { id, url, kind: "web-page", targetSchema, cadenceHint, renderPolicy };
}
