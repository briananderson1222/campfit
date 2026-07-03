/**
 * traverse-recrawl-adapter.ts — the per-camp traverse-backed extraction
 * adapter for RE-crawling one already-known camp (traverse-recrawl-cutover
 * plan, Task 1.3 / AC5 / AC6 / AC7, Stop-short risk 5).
 *
 * This is a DIFFERENT use case from `traverse-pipeline.ts`'s
 * `runTraversePipelineForSource` (built for `scripts/scrape.ts`'s
 * create-if-new listing sweep, which routes EVERY item a page contains,
 * diffed via `traverse-extractor.ts`'s `itemToProposedChanges`, to a sink
 * keyed by extracted item NAME). A re-crawl of one already-known,
 * already-reviewed camp must:
 *
 *  1. Target ONLY that camp's own row for "current" values — never
 *     traverse's `currentByItemNames` name-keyed whole-DB lookup, which is
 *     built for "does a camp with this extracted name already exist
 *     anywhere" (create-if-new), not "diff against the ONE camp I was asked
 *     to re-crawl". A shared listing/domain page could otherwise match (and
 *     silently overwrite) an unrelated camp by name collision.
 *  2. Produce `ProposedChanges` via `diff-engine.ts`'s `computeDiff` — the
 *     confidence floor (`MIN_CONFIDENCE`), the 30-day/0.8-confidence
 *     suppression of recently-approved fields (`fieldSources`), and the
 *     additive-vs-replace array-diff logic all live there and NOWHERE in
 *     `itemToProposedChanges`, which was built for a first-pass/no-history
 *     "populate a brand new item" case. Reusing `itemToProposedChanges` here
 *     would pass type-checking (both produce `ProposedChanges`) while
 *     silently dropping the single most valuable behavior for a RE-crawl:
 *     not re-annoying reviewers with a field they just approved.
 *  3. Never create a new `Camp` row and never route to more than the one
 *     target camp — that's `onboard-url`'s job only.
 *
 * So this module calls the lower-level `runTraverseFetchAndAssemble`
 * (traverse-pipeline.ts) — fetch + shell-retry + per-item grouping, with NO
 * sink-routing and NO `itemToProposedChanges` diffing — then does its own
 * item SELECTION scoped to the known camp (single-item page: unambiguous;
 * multi-item/shared-listing page: match by the known camp's own name among
 * that page's items, or fail loudly as ambiguous — never guess), and its own
 * diffing via the real `computeDiff`.
 *
 * Consumed by `lib/ingestion/crawl-pipeline.ts`'s extraction step
 * (crawl-pipeline.ts:277 pre-migration — the retired hand-rolled per-camp
 * extraction function that lived there, see the migration doc for its name
 * and Wave 2 rewire notes, traverse-recrawl-cutover plan Task 2.1). This
 * module does NOT perform that rewire itself; it only had to produce a
 * result shape Wave 2 could consume with a small adapter step (see
 * `TraverseRecrawlResult`'s doc for exactly what differs from the legacy
 * `LLMExtractionResult` it replaces).
 */

import type { ExtractionProvider } from "@kontourai/traverse";
import type { FetchMode, FetchSourceOptions, SnapshotStore } from "@kontourai/traverse/fetch";
import type { Camp, PricingUnit } from "@/lib/types";
import type { ProposedChanges } from "@/lib/admin/types";
import { runTraverseFetchAndAssemble } from "./traverse-pipeline";
import { itemDisplayName } from "./traverse-extractor";
import type { AssembledItem } from "./traverse-item-grouping";
import { SCALAR_SCHEMA_PATHS } from "./traverse-schema";
import { computeDiff, computeOverallConfidence } from "./diff-engine";
import type { CampInput } from "./adapter";
import type { IngestionSourceConfig } from "./sources";

const DEFAULT_PRICING_UNIT: PricingUnit = "PER_WEEK";

export interface TraverseRecrawlOptions {
  /** the known camp's id. The adapter targets ONLY this camp — it never creates a new `Camp` row and never writes/proposes for any other camp, even when the page it fetches lists several. */
  campId: string;
  /** the known camp's current `websiteUrl` — the page fetched. */
  websiteUrl: string;
  /**
   * the known camp's current `name` — used ONLY to disambiguate which item
   * on a multi-item/shared-listing page corresponds to THIS camp (a local,
   * single-page string comparison). This is deliberately NOT the same thing
   * as traverse's `currentByItemNames` (a whole-DB slug lookup keyed by the
   * EXTRACTED name) — see this module's file doc / Stop-short risk 5.
   */
  campName: string;
  /** the known camp's full current row — `computeDiff`'s `current` (old-value diffing / populate-vs-update). */
  current: Camp;
  /** the known camp's `fieldSources` — `computeDiff`'s 30-day/0.8-confidence suppression of recently-approved fields. */
  fieldSources?: Record<string, { approvedAt?: string }>;
  /**
   * Admin-authored `CrawlSiteHint` rows for this camp's domain, already
   * fetched by the caller (mirrors `crawl-pipeline.ts`:269-274's legacy
   * per-domain hint fetch, preserved unchanged there) — merged into the
   * extraction call's `fieldHints` via `TraversePipelineDeps.extraFieldHints`
   * (traverse-pipeline.ts, Task 1.2). Freeform strings, not tied to one
   * field path, so each is passed through under a synthetic
   * `site-hint-<n>` key — traverse renders every `fieldHints` entry as a
   * `- <key>: <hint>` prompt line regardless of whether the key is a real
   * schema path (see `@kontourai/traverse/anthropic`'s `hintLines`
   * construction), so this is a legitimate, if unconventional, use of the
   * seam.
   */
  siteHints?: string[];
  /**
   * The target camp's community's known neighborhood names (e.g. from
   * `CommunityNeighborhood` rows for the camp's `communitySlug`), fetched by
   * the caller (mirrors `crawl-pipeline.ts`'s pre-Wave-2 legacy neighborhoods
   * query, restored here — Wave 2 gap (a) closure). Rendered as a dedicated
   * `items[].neighborhood` field hint (via `extraFieldHints`, Task 1.2's
   * seam) — NOT folded into the generic `site-hint-<n>` keys above, since
   * this constrains one specific field the same way the retired
   * `llm-provider.ts` `buildPrompt`'s `nbhdRule` did:
   * `` `- neighborhood must be one of these known Denver neighborhoods or
   * null if not found: <list>` `` (captured verbatim before deletion; see
   * {@link neighborhoodFieldHint}). Community-scoped here rather than
   * Denver-hardcoded, since the adapter itself has no community context —
   * the caller passes whichever community's neighborhoods apply to this
   * camp.
   */
  neighborhoods?: string[];
  provider: ExtractionProvider;
  store: SnapshotStore;
  /** fetch mode; default "live-with-capture" (prod). Tests pass "replay" or inject `fetchOptions.fetch`. */
  mode?: FetchMode;
  /** injectable fetch/time seams — network-free tests. */
  fetchOptions?: FetchSourceOptions;
  maxContentChars?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/**
 * Result of {@link runTraverseRecrawlForCamp}. NOT byte-identical to the
 * legacy `LLMExtractionResult` (`lib/admin/types.ts`) it replaces at
 * `crawl-pipeline.ts:277` — this adapter already runs `computeDiff` itself
 * (see the file doc for why), so it hands back `proposedChanges` directly
 * instead of `{extracted, confidence, excerpts}` for the caller to diff.
 * Wave 2 (traverse-recrawl-cutover plan, Task 2.1) needs a small shape
 * adapter at the call site: skip its own inline `computeDiff` call, use
 * `result.proposedChanges` as-is, and pass `result.rawExtraction` straight
 * through to `createProposal` (already an object — no `JSON.parse` step like
 * legacy's `rawResponse` string needed).
 */
export interface TraverseRecrawlResult {
  ok: boolean;
  /**
   * null on success; a stable, kind-tagged reason string on failure.
   * Fetch/extraction failures reuse traverse's own `${kind}: ${message}`
   * convention (`fetchError`/`extractionError` off `TraverseCampFetchResult`)
   * unchanged; item-selection failures this module adds are prefixed
   * `traverse-recrawl:<reason>:` (`no-items` / `ambiguous-multi-item`) so
   * `crawl-failures-table.tsx`'s classifier (Task 2.2, Wave 2) can key off a
   * stable vocabulary instead of collapsing everything into OTHER.
   */
  error: string | null;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  /** `traverse:<model>` — mirrors `traverse-extractor.ts`'s `extractionModel` convention. */
  model: string;
  /** full audit payload for `createProposal`'s `rawExtraction` column — already a plain object, not a JSON string. */
  rawExtraction: Record<string, unknown>;
  /** display name of the item traverse matched to this camp. Null on a no-items/ambiguous failure (nothing was matched). */
  matchedItemName: string | null;
  /** how many items traverse grouped out of the page (1 on a normal single-camp page; >1 on a shared listing page). */
  itemCount: number;
  /** traverse snapshot provenance (see traverse-snapshot-store.ts) — present whenever the fetch captured a snapshot, even on an extraction failure. */
  snapshot: { ref: string | null; bodyHash: string | null };
  tokensUsed: number | null;
  latencyMs: number;
  warnings: string[];
}

/** Freeform `CrawlSiteHint.hint` strings aren't tied to one field path — pass each through under a synthetic key (see `TraverseRecrawlOptions.siteHints`'s doc). */
function siteHintsToFieldHints(siteHints: string[] | undefined): Record<string, string> | undefined {
  if (!siteHints || siteHints.length === 0) return undefined;
  const out: Record<string, string> = {};
  siteHints.forEach((hint, i) => {
    const trimmed = hint.trim();
    if (trimmed) out[`site-hint-${i}`] = trimmed;
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Restores the retired `llm-provider.ts` `buildPrompt`'s neighborhood
 * enum-constraint (`nbhdRule`) via the `items[].neighborhood` field-hint key
 * (traverse-recrawl-cutover Wave 2 gap (a) closure) — the legacy wording,
 * captured before deletion, was:
 * `- neighborhood must be one of these known Denver neighborhoods or null if
 * not found: <comma-joined list>`. Kept community-scoped (not
 * Denver-hardcoded) since the caller supplies whichever community's
 * `CommunityNeighborhood` rows apply to the target camp — see
 * `TraverseRecrawlOptions.neighborhoods`'s doc.
 */
function neighborhoodFieldHint(neighborhoods: string[] | undefined): string | undefined {
  if (!neighborhoods || neighborhoods.length === 0) return undefined;
  return `neighborhood must be one of these known neighborhoods, or null if not found: ${neighborhoods.join(", ")}`;
}

/**
 * Merges `siteHints` (synthetic `site-hint-<n>` keys) and the neighborhood
 * enum-constraint (`items[].neighborhood` key) into one `extraFieldHints`
 * object for `runTraverseFetchAndAssemble` — both AUGMENT
 * `CAMP_FIELD_HINTS`'s static defaults (Task 1.2's merge seam), never
 * replace them.
 */
function buildExtraFieldHints(opts: TraverseRecrawlOptions): Record<string, string> | undefined {
  const out: Record<string, string> = { ...(siteHintsToFieldHints(opts.siteHints) ?? {}) };
  const nbhdHint = neighborhoodFieldHint(opts.neighborhoods);
  if (nbhdHint) out["items[].neighborhood"] = nbhdHint;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Same normalization discipline as the domain-name-generation helpers in crawl-pipeline.ts, kept local here to avoid importing FROM crawl-pipeline.ts (which imports this module after the Wave 2 rewire — a cross-import back would be circular). */
function normalizeItemName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

type ItemSelectionFailureReason = "no-items" | "ambiguous-multi-item";

type ItemSelection =
  | { item: AssembledItem }
  | { reason: ItemSelectionFailureReason; detail: string };

/**
 * Select which of the page's `AssembledItem`s corresponds to the known
 * target camp. Never guesses on ambiguity (Stop-short risk 5):
 *  - 0 items: fails as `no-items`.
 *  - 1 item: unambiguous — a single-item page is assumed to be about the
 *    requested camp (mirrors the retired legacy per-camp extractor's
 *    behavior, which had no multi-item concept at all).
 *  - >1 items: matched by normalized-name equality against the KNOWN camp's
 *    OWN name (not a DB-wide lookup). Exactly one match wins; zero or
 *    multiple matches fail as `ambiguous-multi-item` rather than silently
 *    picking one and risking a wrong-camp write.
 */
function selectTargetItem(items: AssembledItem[], campName: string): ItemSelection {
  if (items.length === 0) {
    return { reason: "no-items", detail: "traverse extracted zero items from this page" };
  }
  if (items.length === 1) {
    return { item: items[0] };
  }
  const targetNorm = normalizeItemName(campName);
  const matches = items.filter((it) => {
    const candidate = it.scalars.name?.candidateValue;
    return typeof candidate === "string" && normalizeItemName(candidate) === targetNorm;
  });
  if (matches.length === 1) {
    return { item: matches[0] };
  }
  return {
    reason: "ambiguous-multi-item",
    detail: `page has ${items.length} items and ${matches.length} name-matched "${campName}" — refusing to guess which one is this camp (shared listing page)`,
  };
}

function meanConfidence(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/**
 * Map one matched item's scalar + nested-array + enum-array fields into the
 * `{extracted, confidence, excerpts}` shape `diff-engine.ts`'s `computeDiff`
 * accepts. Scalars are read via `SCALAR_SCHEMA_PATHS` (traverse-schema.ts) —
 * imported, not hardcoded, so this automatically tracks the field-parity
 * schema (traverse-recrawl-cutover plan Task 1.1) with zero changes here.
 * `campTypes`/`categories` are `AssembledItem`'s enum-array families
 * (traverse-item-grouping.ts's `EnumArrayEntry[]`, Task 1.1) — mirrored here
 * the same way `ageGroups`/`schedules`/`pricing` are, but flattened to bare
 * string arrays (mirrors `diff-engine.ts`'s `ENUM_ARRAY_FIELDS` shape:
 * `extracted[field]` is a string array, `confidence[field]` a single
 * whole-array score).
 */
function assembledItemToDiffInputs(item: AssembledItem): {
  extracted: Partial<CampInput>;
  confidence: Record<string, number>;
  excerpts: Record<string, string>;
} {
  const extracted: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const excerpts: Record<string, string> = {};

  for (const path of SCALAR_SCHEMA_PATHS) {
    const fp = item.scalars[path];
    if (!fp) continue;
    extracted[path] = fp.candidateValue;
    confidence[path] = fp.confidence;
    if (fp.excerpt) excerpts[path] = fp.excerpt;
  }

  if (item.ageGroups.length > 0) {
    extracted.ageGroups = item.ageGroups.map((ag) => ({
      label: ag.label,
      minAge: ag.minAge,
      maxAge: ag.maxAge,
      minGrade: null,
      maxGrade: null,
    }));
    confidence.ageGroups = meanConfidence(item.ageGroups.map((ag) => ag.confidence));
    if (item.ageGroups[0]?.label) excerpts.ageGroups = item.ageGroups[0].label;
  }

  if (item.schedules.length > 0) {
    extracted.schedules = item.schedules.map((s) => ({
      label: s.label,
      startDate: s.startDate ?? "",
      endDate: s.endDate ?? "",
      startTime: null,
      endTime: null,
      earlyDropOff: null,
      latePickup: null,
    }));
    confidence.schedules = meanConfidence(item.schedules.map((s) => s.confidence));
    if (item.schedules[0]?.label) excerpts.schedules = item.schedules[0].label;
  }

  if (item.pricing.length > 0) {
    extracted.pricing = item.pricing.map((p) => ({
      label: p.label,
      amount: p.amount ?? 0,
      unit: DEFAULT_PRICING_UNIT,
      durationWeeks: null,
      ageQualifier: null,
      discountNotes: null,
    }));
    confidence.pricing = meanConfidence(item.pricing.map((p) => p.confidence));
    if (item.pricing[0]?.label) excerpts.pricing = item.pricing[0].label;
  }

  if (item.campTypes.length > 0) {
    extracted.campTypes = item.campTypes.map((c) => c.value);
    confidence.campTypes = meanConfidence(item.campTypes.map((c) => c.confidence));
    if (item.campTypes[0]?.excerpt) excerpts.campTypes = item.campTypes[0].excerpt;
  }

  if (item.categories.length > 0) {
    extracted.categories = item.categories.map((c) => c.value);
    confidence.categories = meanConfidence(item.categories.map((c) => c.confidence));
    if (item.categories[0]?.excerpt) excerpts.categories = item.categories[0].excerpt;
  }

  return { extracted: extracted as Partial<CampInput>, confidence, excerpts };
}

/**
 * Fetch + extract `opts.websiteUrl`, select the item that is `opts.campId`
 * (never a different camp), and diff it via the real `computeDiff` against
 * `opts.current`/`opts.fieldSources`. Never throws — fetch, extraction, and
 * item-selection failures all surface on `result.error` (mirrors
 * `runTraverseFetchAndAssemble`'s / `ingestion-runner.ts`'s per-source
 * isolation contract, extended to per-camp).
 */
export async function runTraverseRecrawlForCamp(
  opts: TraverseRecrawlOptions
): Promise<TraverseRecrawlResult> {
  const src: IngestionSourceConfig = {
    key: opts.campId,
    name: opts.campName,
    url: opts.websiteUrl,
  };

  const fetchResult = await runTraverseFetchAndAssemble(src, {
    provider: opts.provider,
    store: opts.store,
    // `runTraverseFetchAndAssemble` never calls `sink` (it only fetches +
    // groups) — a no-op satisfies `TraversePipelineDeps`'s structural
    // requirement without implying any routing happens here.
    sink: async () => null,
    mode: opts.mode,
    fetchOptions: opts.fetchOptions,
    extraFieldHints: buildExtraFieldHints(opts),
    maxContentChars: opts.maxContentChars,
    log: opts.log,
    now: opts.now,
  });

  const shared = {
    model: fetchResult.model ? `traverse:${fetchResult.model}` : "traverse:unknown",
    snapshot: { ref: fetchResult.snapshotRef, bodyHash: fetchResult.snapshotBodyHash },
    tokensUsed: fetchResult.tokensUsed,
    latencyMs: fetchResult.latencyMs,
    warnings: fetchResult.warnings,
  };

  if (!fetchResult.ok) {
    const error =
      fetchResult.fetchError ?? fetchResult.extractionError ?? "traverse: fetch/extraction failed with no snapshot";
    return {
      ok: false,
      error,
      proposedChanges: {},
      overallConfidence: 0,
      matchedItemName: null,
      itemCount: fetchResult.items.length,
      rawExtraction: { via: "traverse-recrawl", campId: opts.campId, error, warnings: fetchResult.warnings },
      ...shared,
    };
  }

  const selection = selectTargetItem(fetchResult.items, opts.campName);
  if ("reason" in selection) {
    const error = `traverse-recrawl:${selection.reason}: ${selection.detail}`;
    return {
      ok: false,
      error,
      proposedChanges: {},
      overallConfidence: 0,
      matchedItemName: null,
      itemCount: fetchResult.items.length,
      rawExtraction: {
        via: "traverse-recrawl",
        campId: opts.campId,
        error,
        itemCount: fetchResult.items.length,
        warnings: fetchResult.warnings,
      },
      ...shared,
    };
  }

  const item = selection.item;
  const { extracted, confidence, excerpts } = assembledItemToDiffInputs(item);
  const proposedChanges = computeDiff(
    opts.current,
    extracted,
    confidence,
    excerpts,
    opts.fieldSources ?? {},
    opts.websiteUrl
  );

  return {
    ok: true,
    error: null,
    proposedChanges,
    overallConfidence: computeOverallConfidence(proposedChanges),
    matchedItemName: itemDisplayName(item),
    itemCount: fetchResult.items.length,
    rawExtraction: {
      via: "traverse-recrawl",
      campId: opts.campId,
      itemIndex: item.itemIndex,
      itemName: itemDisplayName(item),
      itemCount: fetchResult.items.length,
      proposals: item.allProposals,
      itemWarnings: item.warnings,
      warnings: fetchResult.warnings,
    },
    ...shared,
  };
}
