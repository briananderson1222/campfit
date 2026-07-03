/**
 * traverse-item-grouping.ts — regroups traverse's flat `ExtractionProposal[]`
 * (from the per-item `CAMP_TARGET_SCHEMA` in traverse-schema.ts) back into
 * one structured record PER SOURCE ITEM (per camp/course/program on the
 * page), using `ExtractionProposal.pathIndices` (present since
 * @kontourai/traverse@0.4.0).
 *
 * This is the engine that kills the "cross-band stitching" failure class the
 * slice-2b adjudication flagged (docs/traverse-adjudication-2026-07.md): with
 * the old single-entity schema, a proposal like "ageGroups[].minAge" and
 * another "ageGroups[].maxAge" had no way to know if they came from the SAME
 * age band on the page — they were composed into one record regardless,
 * sometimes stitching unrelated bands together (Denver: minAge from "Ages
 * 5-6", maxAge from an unrelated "ages 15-17" teen workshop).
 *
 * How grouping works:
 *  - `pathIndices[0]` (present whenever the model echoed an indexed
 *    `items[N]...` source path — see traverse-schema.ts's header) identifies
 *    WHICH item/camp a proposal belongs to. Absent `pathIndices` (the model
 *    used the un-indexed declared path directly, valid for a single-item
 *    page) is treated as item 0.
 *  - `pathIndices[1]`, when present, identifies which nested row (age band /
 *    session / price tier) within that item a `ageGroups[]` / `schedules[]` /
 *    `pricing[]` field belongs to — so a camp's own ages/dates/price come
 *    ONLY from its own item + its own sub-item group, never a different one.
 *  - When a provider does not index a nested array at all (valid when an
 *    item genuinely has only one band/session/price), proposals for that
 *    nested field are paired POSITIONALLY in encounter order (the Nth
 *    `minAge` pairs with the Nth `maxAge`) — still scoped to the correct
 *    ITEM (no cross-camp stitching is possible either way), and a warning is
 *    recorded so this degraded-but-still-item-scoped path stays visible
 *    rather than silent.
 *
 * Cross-CHUNK item-index rebasing (traverse 0.5.0+ structural chunking).
 * `pathIndices[0]` is derived from the indexed source path a provider echoes
 * back FOR ONE CHUNK's tool-use call (see traverse's extract.js
 * normalizeChunkProposals) — traverse itself does not (and, per its own
 * README/ADR 0004, cannot: `ExtractionProposal` carries no chunk id) make it
 * globally unique across chunks. Empirically (live idtech run, 2026-07),
 * glm-5.2 numbers each chunk's `items[N]` from N=0 again, so a naive "group by
 * raw pathIndices[0]" silently MERGES chunk 2's item 0 into chunk 1's item 0
 * (and so on) — reintroducing exactly the cross-item stitching class this
 * module exists to prevent, just at chunk granularity instead of field
 * granularity. `assignGlobalItemIndices()` below closes that gap with a
 * heuristic: proposals are collected chunk-by-chunk in order (extract.js
 * pushes each chunk's normalized proposals sequentially, and dedup preserves
 * first-seen order), and WITHIN one chunk a well-behaved provider emits a
 * given item's fields together before moving to the next item, so
 * `pathIndices[0]` is non-decreasing until a chunk boundary — a DECREASE is
 * therefore treated as "a new chunk started" and subsequent indices are
 * rebased past the highest index already used. This is a heuristic (traverse
 * does not expose a per-proposal chunk id to make it exact), so each rebase
 * point is recorded as a warning on the item where it was detected rather
 * than applied silently.
 */

import type { ExtractionProposal } from "@kontourai/traverse";
import { ITEMS_ARRAY_PREFIX, SCALAR_SCHEMA_PATHS, type ScalarSchemaPath } from "./traverse-schema";

/** One nested array field family this module reconstructs full rows for. */
const NESTED_ARRAY_FIELDS: Record<string, string[]> = {
  "ageGroups[]": ["minAge", "maxAge"],
  "schedules[]": ["startDate", "endDate"],
  "pricing[]": ["amount"],
};

export interface FieldProposal {
  candidateValue: unknown;
  confidence: number;
  excerpt: string;
  locator: string;
  extractor: string;
}

export interface AssembledItem {
  /** the source item index (pathIndices[0], or 0 when the model didn't index). */
  itemIndex: number;
  /** bare scalar field -> its single proposal (e.g. "name", "city"). */
  scalars: Partial<Record<ScalarSchemaPath, FieldProposal>>;
  /** each entry is one age band, fully reconstructed from its own excerpt(s). */
  ageGroups: { minAge: number | null; maxAge: number | null; label: string; confidence: number }[];
  /** each entry is one session, fully reconstructed from its own excerpt(s). */
  schedules: { startDate: string | null; endDate: string | null; label: string; confidence: number }[];
  /** each entry is one price tier, fully reconstructed from its own excerpt(s). */
  pricing: { amount: number | null; label: string; confidence: number }[];
  /** every proposal that contributed to this item, for audit (rawExtraction). */
  allProposals: ExtractionProposal[];
  /** non-fatal notes, e.g. positional-pairing fallback used for an unindexed nested field. */
  warnings: string[];
}

function toFieldProposal(p: ExtractionProposal): FieldProposal {
  return {
    candidateValue: p.candidateValue,
    confidence: p.confidence,
    excerpt: p.provenance.excerpt,
    locator: p.provenance.locator,
    extractor: p.extractor,
  };
}

interface RelativeProposal {
  /** fieldPath with the "items[]." prefix stripped, e.g. "name" or "ageGroups[].minAge". */
  relPath: string;
  /** pathIndices[1] when present — the nested row this belongs to. */
  subIndex?: number;
  proposal: ExtractionProposal;
}

const LOCATOR_START_RE = /^chars:(\d+)-\d+$/;

/** Parse the verified `"chars:<start>-<end>"` locator's start offset, or null if unparseable. */
function locatorStart(locator: string): number | null {
  const m = LOCATOR_START_RE.exec(locator);
  return m ? Number(m[1]) : null;
}

/**
 * Rebase each `items[]`-prefixed proposal's raw `pathIndices[0]` into a
 * document-global item index. Proposals are walked in their given order
 * (callers must pass `result.proposals` as-is — traverse preserves
 * chunk-then-emission order through collection/dedup).
 *
 * A DECREASE in the raw index alone is not a safe chunk-boundary signal on
 * its own: a provider is allowed to emit a schema-declared array's proposals
 * out of item order WITHIN one chunk (traverse's own grouping contract is
 * index-based, not emission-order-based — see the module header), which
 * looks identical to a chunk restart if only the index is watched. The
 * verified `provenance.locator` (a real offset into the shared, monotonic
 * `fullText` — see traverse's extract.js) disambiguates the two cases:
 *  - Revisiting an EARLIER item within the same chunk moves the index AND
 *    the locator backward together (both refer to earlier document
 *    content) — NOT a chunk boundary.
 *  - A genuine chunk restart moves the index backward while the locator
 *    keeps moving FORWARD (chunk 2's card content is later in `fullText`
 *    than chunk 1's, even though its own item numbering restarts at 0) —
 *    THIS is rebased.
 * A proposal whose locator cannot be parsed (should not happen post
 * normalization) is treated as "did not move the document position",
 * i.e. never itself triggers a rebase.
 *
 * Returns each proposal paired with its rebased global index, plus
 * `chunkBoundaryIndices` — the global index of the FIRST item of every chunk
 * after the first (i.e. every point a rebase actually happened) — so callers
 * can attach a visible warning instead of rebasing silently.
 */
function assignGlobalItemIndices(proposals: ExtractionProposal[]): {
  items: { globalIndex: number; proposal: ExtractionProposal }[];
  chunkBoundaryIndices: Set<number>;
} {
  let base = 0;
  let runningMaxIndex = -1;
  let maxLocatorStart = -1;
  const items: { globalIndex: number; proposal: ExtractionProposal }[] = [];
  const chunkBoundaryIndices = new Set<number>();
  for (const p of proposals) {
    if (!p.fieldPath.startsWith(ITEMS_ARRAY_PREFIX)) continue; // schema-shape guard
    const localIndex = p.pathIndices?.[0] ?? 0;
    const thisLocatorStart = locatorStart(p.provenance.locator) ?? -1;

    const indexWentBack = localIndex < runningMaxIndex;
    const documentWentBack = thisLocatorStart < maxLocatorStart;
    if (indexWentBack && !documentWentBack) {
      // Index restarted at/near 0 while the document position kept moving
      // forward — a chunk boundary, not an out-of-order proposal within the
      // same chunk. Rebase past every index already used in this run.
      base += runningMaxIndex + 1;
      runningMaxIndex = -1;
      chunkBoundaryIndices.add(base + localIndex);
    }
    runningMaxIndex = Math.max(runningMaxIndex, localIndex);
    maxLocatorStart = Math.max(maxLocatorStart, thisLocatorStart);
    items.push({ globalIndex: base + localIndex, proposal: p });
  }
  return { items, chunkBoundaryIndices };
}

/** Group a full extraction's proposals by their (chunk-rebased) source item. */
function groupByItemIndex(
  proposals: ExtractionProposal[]
): { groups: Map<number, RelativeProposal[]>; chunkBoundaryIndices: Set<number> } {
  const { items, chunkBoundaryIndices } = assignGlobalItemIndices(proposals);
  const groups = new Map<number, RelativeProposal[]>();
  for (const { globalIndex, proposal: p } of items) {
    const relPath = p.fieldPath.slice(ITEMS_ARRAY_PREFIX.length);
    const subIndex = p.pathIndices && p.pathIndices.length > 1 ? p.pathIndices[1] : undefined;
    const list = groups.get(globalIndex) ?? [];
    list.push({ relPath, subIndex, proposal: p });
    groups.set(globalIndex, list);
  }
  return { groups, chunkBoundaryIndices };
}

/**
 * Reconstruct full rows for one nested array family (e.g. ageGroups[]) within
 * one item, from its relative proposals. Indexed entries (pathIndices[1]
 * present) group exactly by that index; un-indexed entries pair positionally
 * per sub-field in encounter order. Returns rows in index order (indexed
 * rows first, by index; then positional rows), plus any warnings.
 */
function assembleNestedRows(
  entries: RelativeProposal[],
  subFields: string[]
): { rows: Map<string, FieldProposal>[]; warnings: string[] } {
  const warnings: string[] = [];
  const indexedRows = new Map<number, Map<string, FieldProposal>>();
  const unindexedQueues = new Map<string, FieldProposal[]>();

  for (const entry of entries) {
    // relPath looks like "ageGroups[].minAge" — the sub-field is the last segment.
    const subField = entry.relPath.split(".").pop() ?? entry.relPath;
    if (!subFields.includes(subField)) continue;
    const fp = toFieldProposal(entry.proposal);
    if (entry.subIndex !== undefined) {
      const row = indexedRows.get(entry.subIndex) ?? new Map<string, FieldProposal>();
      row.set(subField, fp);
      indexedRows.set(entry.subIndex, row);
    } else {
      const q = unindexedQueues.get(subField) ?? [];
      q.push(fp);
      unindexedQueues.set(subField, q);
    }
  }

  const positionalRowCount = Math.max(0, ...subFields.map((f) => (unindexedQueues.get(f) ?? []).length));
  if (positionalRowCount > 0) {
    warnings.push(
      `nested field group [${subFields.join(",")}] had un-indexed proposals — paired ${positionalRowCount} row(s) positionally by encounter order (still item-scoped, not cross-item)`
    );
  }
  const positionalRows: Map<string, FieldProposal>[] = [];
  for (let i = 0; i < positionalRowCount; i++) {
    const row = new Map<string, FieldProposal>();
    for (const f of subFields) {
      const q = unindexedQueues.get(f);
      if (q && q[i]) row.set(f, q[i]);
    }
    positionalRows.push(row);
  }

  const rows = [
    ...[...indexedRows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row),
    ...positionalRows,
  ];
  return { rows, warnings };
}

function rowExcerpt(row: Map<string, FieldProposal>): string {
  return [...row.values()][0]?.excerpt ?? "";
}

function rowConfidence(row: Map<string, FieldProposal>): number {
  const values = [...row.values()];
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v.confidence, 0) / values.length) * 100) / 100;
}

/**
 * Group a full traverse extraction's proposals into one {@link AssembledItem}
 * per source item, ordered by item index.
 */
export function assembleItems(proposals: ExtractionProposal[]): AssembledItem[] {
  const { groups: byItem, chunkBoundaryIndices } = groupByItemIndex(proposals);
  const items: AssembledItem[] = [];

  for (const [itemIndex, entries] of [...byItem.entries()].sort((a, b) => a[0] - b[0])) {
    const scalars: Partial<Record<ScalarSchemaPath, FieldProposal>> = {};
    const warnings: string[] = [];
    const allProposals: ExtractionProposal[] = [];

    if (chunkBoundaryIndices.has(itemIndex)) {
      warnings.push(
        `item index ${itemIndex} was rebased across a traverse chunk boundary (the provider's raw pathIndices[0] restarted at 0 for a later chunk) — grouped via a decreasing-index heuristic, not a chunk id traverse itself exposes; verify this item is not merged with an unrelated one`
      );
    }

    for (const scalarPath of SCALAR_SCHEMA_PATHS) {
      const match = entries.find((e) => e.relPath === scalarPath);
      if (match) scalars[scalarPath] = toFieldProposal(match.proposal);
    }

    const ageGroupEntries = entries.filter((e) => e.relPath.startsWith("ageGroups[]."));
    const scheduleEntries = entries.filter((e) => e.relPath.startsWith("schedules[]."));
    const pricingEntries = entries.filter((e) => e.relPath.startsWith("pricing[]."));

    const ageGroupResult = assembleNestedRows(ageGroupEntries, NESTED_ARRAY_FIELDS["ageGroups[]"]);
    const scheduleResult = assembleNestedRows(scheduleEntries, NESTED_ARRAY_FIELDS["schedules[]"]);
    const pricingResult = assembleNestedRows(pricingEntries, NESTED_ARRAY_FIELDS["pricing[]"]);
    warnings.push(...ageGroupResult.warnings, ...scheduleResult.warnings, ...pricingResult.warnings);

    const ageGroups = ageGroupResult.rows
      .filter((row) => row.size > 0)
      .map((row) => ({
        minAge: (row.get("minAge")?.candidateValue as number | undefined) ?? null,
        maxAge: (row.get("maxAge")?.candidateValue as number | undefined) ?? null,
        label: rowExcerpt(row),
        confidence: rowConfidence(row),
      }));

    const schedules = scheduleResult.rows
      .filter((row) => row.size > 0)
      .map((row) => ({
        startDate: (row.get("startDate")?.candidateValue as string | undefined) ?? null,
        endDate: (row.get("endDate")?.candidateValue as string | undefined) ?? null,
        label: rowExcerpt(row),
        confidence: rowConfidence(row),
      }));

    const pricing = pricingResult.rows
      .filter((row) => row.size > 0)
      .map((row) => ({
        amount: (row.get("amount")?.candidateValue as number | undefined) ?? null,
        label: rowExcerpt(row),
        confidence: rowConfidence(row),
      }));

    for (const e of entries) allProposals.push(e.proposal);

    items.push({ itemIndex, scalars, ageGroups, schedules, pricing, allProposals, warnings });
  }

  return items;
}
