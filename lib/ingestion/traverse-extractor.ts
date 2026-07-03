/**
 * traverse-extractor.ts — FULL CUTOVER wiring for @kontourai/traverse.
 *
 * Runs `extract()` against the per-item `CAMP_TARGET_SCHEMA`
 * (traverse-schema.ts), then uses `assembleItems()`
 * (traverse-item-grouping.ts) to regroup the flat proposal list — via
 * traverse 0.4.0's `ExtractionProposal.pathIndices` — into one structured
 * record PER SOURCE ITEM (per camp/course/program a listing page contains).
 * Each item's record is mapped into CampFit's existing human-review sink —
 * the `ProposedChanges` / `createProposal` contract the review UI and
 * `app/api/admin/review/[id]/approve/route.ts` already consume.
 *
 * Discipline (ADR 0003-style, unchanged from the pilot): traverse emits
 * PROPOSALS, never writes. This module converts them to `ProposedChanges`
 * and shapes `createProposal` arguments per item; it deliberately does NOT
 * call the DB itself. The caller (lib/ingestion/traverse-pipeline.ts) is
 * responsible for resolving a campId per item and performing the write
 * after human review.
 *
 * Nested-array fix (full cutover): the pilot's array proposals
 * (`"ageGroups[].minAge"`, etc.) were keyed by their raw traverse fieldPath,
 * which `app/api/admin/review/[id]/approve/route.ts`'s RELATIONS map never
 * matched (it expects bare `"ageGroups"` / `"schedules"` / `"pricing"` keys
 * whose `FieldDiff.new` is an ARRAY of full row objects) — so those pilot
 * proposals were inert on approve. This module now emits exactly that
 * bare-key, full-row-array shape, reconstructed by `assembleItems()` from
 * each item's own excerpts (no cross-band stitching), so nested proposals
 * are actually appliable.
 */

import { extract } from "@kontourai/traverse";
import type {
  ExtractionProvider,
  ExtractionProposal,
  ExtractionResult,
} from "@kontourai/traverse";
import type { FieldDiff, ProposedChanges } from "@/lib/admin/types";
import type { PricingUnit } from "@/lib/types";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS, SCALAR_SCHEMA_PATHS } from "./traverse-schema";
import { assembleItems, type AssembledItem } from "./traverse-item-grouping";

export interface TraverseExtractOptions {
  /** Raw page content (html) or already-extracted text. */
  content: string;
  contentType?: "html" | "text";
  /** Stable source ref for provenance (usually the fetched/snapshot URL). */
  sourceRef: string;
  /** Any ExtractionProvider — the Anthropic adapter in prod, a stub in tests. */
  provider: ExtractionProvider;
  maxContentChars?: number;
}

/**
 * Run traverse extraction for a single page against the per-item camp
 * schema. Never throws (traverse's `extract()` never throws — any stage
 * error is on `result.error` with empty proposals).
 */
export async function runTraverseExtraction(
  opts: TraverseExtractOptions
): Promise<ExtractionResult> {
  return extract({
    content: opts.content,
    contentType: opts.contentType ?? "html",
    sourceRef: opts.sourceRef,
    targetSchema: CAMP_TARGET_SCHEMA,
    fieldHints: CAMP_FIELD_HINTS,
    provider: opts.provider,
    maxContentChars: opts.maxContentChars,
  });
}

const DEFAULT_PRICING_UNIT: PricingUnit = "PER_WEEK";

function normalizeScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim().toLowerCase();
}

function meanConfidence(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/** Best-effort display name for one item, for logging/anchor-camp lookup. */
export function itemDisplayName(item: AssembledItem): string {
  const name = item.scalars.name?.candidateValue;
  return typeof name === "string" && name.trim() ? name.trim() : `Untitled item ${item.itemIndex}`;
}

/**
 * Map one assembled item's fields into CampFit's `ProposedChanges` review
 * shape.
 *
 * - Scalar fields (name, description, category, …) are diffed against the
 *   current camp value: emitted only when the proposed value differs, with
 *   mode 'populate' when the current value is empty else 'update'.
 * - Nested arrays (ageGroups, schedules, pricing) are emitted under their
 *   BARE key as a full array of reconstructed rows (mode 'add_items',
 *   old: null) — the shape `approve/route.ts`'s RELATIONS handling expects.
 *
 * Every emitted `FieldDiff` carries an `excerpt` and `sourceUrl`, exactly
 * like the legacy LLM extractor's diffs, so the review UI renders
 * provenance unchanged.
 */
export function itemToProposedChanges(
  item: AssembledItem,
  current: Record<string, unknown> = {},
  sourceUrl = ""
): ProposedChanges {
  const changes: ProposedChanges = {};

  for (const scalarPath of SCALAR_SCHEMA_PATHS) {
    const fp = item.scalars[scalarPath];
    if (!fp) continue;
    const currentVal = current[scalarPath];
    if (normalizeScalar(currentVal) === normalizeScalar(fp.candidateValue)) continue;
    const isEmpty = currentVal === null || currentVal === undefined || currentVal === "";
    const diff: FieldDiff = {
      old: (currentVal as FieldDiff["old"]) ?? null,
      new: fp.candidateValue,
      confidence: fp.confidence,
      mode: isEmpty ? "populate" : "update",
      excerpt: fp.excerpt,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
    changes[scalarPath] = diff;
  }

  if (item.ageGroups.length > 0) {
    changes["ageGroups"] = {
      old: null,
      new: item.ageGroups.map((ag) => ({
        label: ag.label,
        minAge: ag.minAge,
        maxAge: ag.maxAge,
        minGrade: null,
        maxGrade: null,
      })),
      confidence: meanConfidence(item.ageGroups.map((ag) => ag.confidence)),
      mode: "add_items",
      excerpt: item.ageGroups[0].label,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  if (item.schedules.length > 0) {
    changes["schedules"] = {
      old: null,
      new: item.schedules.map((s) => ({
        label: s.label,
        startDate: s.startDate,
        endDate: s.endDate,
        startTime: null,
        endTime: null,
        earlyDropOff: null,
        latePickup: null,
      })),
      confidence: meanConfidence(item.schedules.map((s) => s.confidence)),
      mode: "add_items",
      excerpt: item.schedules[0].label,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  if (item.pricing.length > 0) {
    changes["pricing"] = {
      old: null,
      new: item.pricing.map((p) => ({
        label: p.label,
        amount: p.amount ?? 0,
        unit: DEFAULT_PRICING_UNIT,
        durationWeeks: null,
        ageQualifier: null,
        discountNotes: null,
      })),
      confidence: meanConfidence(item.pricing.map((p) => p.confidence)),
      mode: "add_items",
      excerpt: item.pricing[0].label,
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  }

  return changes;
}

/** Weighted-free mean confidence across a proposal set, clamped to 2dp. */
export function overallConfidence(proposals: ExtractionProposal[]): number {
  if (proposals.length === 0) return 0;
  return meanConfidence(proposals.map((p) => p.confidence));
}

export interface TraverseItemProposalRecord {
  itemIndex: number;
  itemName: string;
  sourceUrl: string;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  extractionModel: string;
  /** Full traverse audit payload for THIS item — its own proposals + shared raw/warnings. */
  rawExtraction: Record<string, unknown>;
  /** Non-fatal notes for this item (dropped/clamped proposals, positional-pairing fallback). */
  warnings: string[];
}

/**
 * Run `assembleItems()` over a full extraction result and shape one
 * `createProposal`-ready record PER ITEM. Does not perform the write; the
 * caller resolves a campId per item and calls `createProposal`.
 *
 * `currentByItemName` lets the caller supply each item's existing camp
 * field values (keyed by the item's display name) for scalar
 * populate-vs-update diffing; omitted/unmatched items diff against `{}`
 * (every scalar treated as 'populate').
 */
export function buildTraverseItemProposalRecords(
  result: ExtractionResult,
  opts: {
    sourceUrl?: string;
    currentByItemName?: Map<string, Record<string, unknown>>;
  } = {}
): TraverseItemProposalRecord[] {
  const sourceUrl = opts.sourceUrl ?? "";
  const items = assembleItems(result.proposals);

  return items.map((item) => {
    const itemName = itemDisplayName(item);
    const current = opts.currentByItemName?.get(itemName) ?? {};
    const proposedChanges = itemToProposedChanges(item, current, sourceUrl);
    const extractionModel = result.raw?.model ? `traverse:${result.raw.model}` : "traverse:unknown";

    return {
      itemIndex: item.itemIndex,
      itemName,
      sourceUrl,
      proposedChanges,
      overallConfidence: overallConfidence(item.allProposals),
      extractionModel,
      rawExtraction: {
        via: "traverse",
        extractedAt: result.extractedAt,
        itemIndex: item.itemIndex,
        proposals: item.allProposals,
        raw: result.raw,
        warnings: [...(result.warnings ?? []), ...item.warnings],
      },
      warnings: item.warnings,
    };
  });
}
