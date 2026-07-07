/**
 * lib/ingestion/aggregator/aggregator-schema.ts — the aggregator candidate
 * extraction target (campfit#93, R2).
 *
 * Deliberately a FLAT, three-field schema — NOT a reuse of
 * `lib/ingestion/traverse-schema.ts`'s `CAMP_TARGET_SCHEMA` (that schema is
 * camp-specific: enum categories, nested age/schedule/pricing rows) — an
 * aggregator candidate is just "a provider this page lists", surfaced to a
 * human for dedupe-check + onboarding, not a fully-enriched camp record.
 *
 * Every path is scoped under `items[]` (one entry per distinct provider the
 * aggregator page lists), mirroring `CAMP_TARGET_SCHEMA`'s own per-item
 * convention so `ExtractionProposal.pathIndices` (traverse ADR 0003) can be
 * used the same way — see `aggregator-item-grouping.ts`'s
 * `groupAggregatorCandidates`, a small dedicated grouping helper (NOT a reuse
 * of `traverse-item-grouping.ts`'s `assembleItems`, which is coupled to the
 * nested age/schedule/pricing/enum-array families this schema doesn't have).
 *
 * The explicit "never the aggregator's own name/site" guidance below (both in
 * the schema `description`s and in `AGGREGATOR_CANDIDATE_FIELD_HINTS`) exists
 * because an aggregator page's own branding/title text sits right next to the
 * providers it lists — without this guard a schema-directed extraction could
 * plausibly propose the aggregator site itself as a "candidate provider".
 */

import type { TargetFieldSchema } from "@kontourai/traverse";

/** The declared items[] array field this schema enumerates. Every path is scoped under it. */
export const AGGREGATOR_ITEMS_ARRAY_PREFIX = "items[].";

/**
 * The three-field aggregator-candidate schema: a provider's name, its own
 * website, and the locale it serves — exactly the fields R2 asks discovery
 * to surface, each carrying its own provenance once through `extract()`.
 */
export const AGGREGATOR_CANDIDATE_TARGET_SCHEMA: TargetFieldSchema[] = [
  {
    path: "items[].name",
    type: "string",
    required: true,
    description:
      "The name of ONE camp provider/organization listed on this aggregator page (e.g. a summer camp operator, school, or community organization). NEVER the aggregator/listing site's own name, title, or brand — only a distinct provider THAT PAGE LISTS gets its own items[] entry.",
  },
  {
    path: "items[].websiteUrl",
    type: "string",
    description:
      "This specific provider's OWN homepage or program-listing URL — NOT the aggregator site's own URL, and not a generic \"view listing\"/\"learn more\" link that stays on the aggregator's own domain.",
  },
  {
    path: "items[].locale",
    type: "string",
    description:
      "The city, region, or locale this provider serves or operates in, exactly as stated on the page (e.g. \"Denver, CO\" or \"Boulder\"). Only set when the page states it for THIS provider.",
  },
];

/**
 * Per-field hints reinforcing the schema `description`s above, most
 * importantly the "never propose the aggregator itself" guard.
 */
export const AGGREGATOR_CANDIDATE_FIELD_HINTS: Record<string, string> = {
  "items[].name":
    "Do not propose the aggregator/listing site itself (its own brand, title, or company name) as a candidate — only the individual camp providers/organizations IT lists. If the page lists several distinct providers, extract EACH one as its own items[] entry.",
  "items[].websiteUrl":
    "Link to the provider's own site. Do not propose a URL on the aggregator's own domain (e.g. a /listings/ or /providers/ detail page hosted by the aggregator) as this field's value.",
  "items[].locale":
    "Use the city/region text as written on the page for THIS provider; do not infer a locale that isn't stated.",
};
