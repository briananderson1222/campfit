/**
 * lib/ingestion/aggregator/aggregator-item-grouping.ts — regroups traverse's
 * flat `ExtractionProposal[]` (from `AGGREGATOR_CANDIDATE_TARGET_SCHEMA`,
 * see aggregator-schema.ts) back into one record PER SOURCE ITEM (per
 * provider listed on the aggregator page), using
 * `ExtractionProposal.pathIndices` (present since @kontourai/traverse@0.4.0).
 *
 * Deliberately a NEW, small grouping function — NOT a reuse of
 * `lib/ingestion/traverse-item-grouping.ts`'s `assembleItems`, which is
 * coupled to `CAMP_TARGET_SCHEMA`'s nested age/schedule/pricing rows and
 * enum-array families (plus its own cross-chunk item-index rebasing
 * heuristic for that camp-specific multi-page-chunking shape). This schema
 * has exactly three flat scalar fields per item and no nested arrays, so the
 * grouping need only bucket by `pathIndices[0]` (the item index; absent —
 * the model used the un-indexed declared path directly — is treated as item
 * 0, the same convention traverse's own ADR 0003 establishes) and keep each
 * field's own `ExtractionProposal.provenance` (`{excerpt, locator}`)
 * attached, unchanged — this is the provenance R2 requires to survive from
 * `extract()` through to the enqueued `ProviderCandidate` row.
 */

import type { ExtractionProposal } from "@kontourai/traverse";
import { AGGREGATOR_ITEMS_ARRAY_PREFIX } from "./aggregator-schema";

/** One field's proposed value with its own provenance, unchanged from `ExtractionProposal.provenance`. */
export interface AggregatorCandidateFieldValue {
  value: string;
  provenance: { excerpt: string; locator: string };
}

/** The three fields `AGGREGATOR_CANDIDATE_TARGET_SCHEMA` declares, relative to `items[].`. */
export type AggregatorCandidateFieldName = "name" | "websiteUrl" | "locale";

const FIELD_NAMES: readonly AggregatorCandidateFieldName[] = ["name", "websiteUrl", "locale"];

/**
 * One reconstructed candidate item. `name` is the only field
 * `AGGREGATOR_CANDIDATE_TARGET_SCHEMA` marks `required`, but a proposal set
 * that never emitted it is still represented here (with `name` absent) —
 * grouping never drops an item; the caller (aggregator-extraction.ts)
 * decides whether a nameless item is worth enqueuing.
 */
export interface AggregatorCandidateItem {
  /** the source item index (pathIndices[0], or 0 when the model didn't index). */
  itemIndex: number;
  name?: AggregatorCandidateFieldValue;
  websiteUrl?: AggregatorCandidateFieldValue;
  locale?: AggregatorCandidateFieldValue;
}

function isAggregatorFieldName(relPath: string): relPath is AggregatorCandidateFieldName {
  return (FIELD_NAMES as readonly string[]).includes(relPath);
}

/**
 * Group one extraction's proposals into one {@link AggregatorCandidateItem}
 * per source item, ordered by item index. A field proposed more than once
 * for the same item (e.g. a provider mentioned twice on one page) keeps the
 * LAST proposal encountered — mirrors `Map.set`'s natural overwrite
 * semantics; every existing caller only ever proposes each field once per
 * item, so this only matters for a malformed/duplicate-emitting provider.
 */
export function groupAggregatorCandidates(proposals: ExtractionProposal[]): AggregatorCandidateItem[] {
  const byIndex = new Map<number, AggregatorCandidateItem>();

  for (const proposal of proposals) {
    if (!proposal.fieldPath.startsWith(AGGREGATOR_ITEMS_ARRAY_PREFIX)) continue;
    const relPath = proposal.fieldPath.slice(AGGREGATOR_ITEMS_ARRAY_PREFIX.length);
    if (!isAggregatorFieldName(relPath)) continue;

    const itemIndex = proposal.pathIndices?.[0] ?? 0;
    const item: AggregatorCandidateItem = byIndex.get(itemIndex) ?? { itemIndex };
    item[relPath] = {
      value: String(proposal.candidateValue),
      provenance: { excerpt: proposal.provenance.excerpt, locator: proposal.provenance.locator },
    };
    byIndex.set(itemIndex, item);
  }

  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
}
