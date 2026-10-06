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
 *    session / price tier) — or, for the enum-array families below, which
 *    array SLOT (e.g. `campTypes[N]`) — within that item a `ageGroups[]` /
 *    `schedules[]` / `pricing[]` / `campTypes[]` / `categories[]` field
 *    belongs to — so a camp's own ages/dates/price/types/categories come
 *    ONLY from its own item, never a different one.
 *  - When a provider does not index a nested array at all (valid when an
 *    item genuinely has only one band/session/price/type/category), proposals
 *    for that field are paired POSITIONALLY in encounter order — still
 *    scoped to the correct ITEM (no cross-camp stitching is possible either
 *    way), and a warning is recorded so this degraded-but-still-item-scoped
 *    path stays visible rather than silent.
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
 *
 * ENUM-ARRAY FAMILIES (traverse-recrawl-cutover, 2026-07, AC5): `campTypes`
 * and `categories` are lists of enum STRINGS on one item — declared in
 * traverse-schema.ts as `items[].campTypes[]` / `items[].categories[]` — not
 * row objects with multiple sub-fields like `ageGroups[]`/`schedules[]`/
 * `pricing[]`. `assembleEnumArrayEntries()` below is the matching
 * reconstruction logic: it groups a field's proposals by `pathIndices[1]`
 * (the array slot) when indexed, falls back to encounter order when not, and
 * de-duplicates repeated identical values (keeping the highest-confidence
 * occurrence) — a provider is free to emit the same tag/category more than
 * once across chunks without producing a duplicated array entry downstream.
 */

import type { ExtractionProposal } from "@kontourai/traverse";
import type { PricingUnit } from "@/lib/types";
import { canonicalTime, textStatesOnlyRange, textStatesTime } from "./session-time";
import {
  CAMP_TARGET_SCHEMA,
  ENUM_ARRAY_SCHEMA_PATHS,
  ITEMS_ARRAY_PREFIX,
  PRICING_UNIT_VALUES,
  SCALAR_SCHEMA_PATHS,
  type EnumArraySchemaPath,
  type ItemFieldPath,
} from "./traverse-schema";

/** One nested array field family this module reconstructs full rows for. */
const NESTED_ARRAY_FIELDS: Record<string, string[]> = {
  "ageGroups[]": ["minAge", "maxAge"],
  "schedules[]": ["startDate", "endDate", "startTime", "endTime"],
  "pricing[]": ["amount", "unit"],
  "socialLinks[]": ["platform", "url"],
};

/** Schema entry per path relative to one item (`category`, `campTypes[]`, `schedules[].startDate`, ...). */
const SCHEMA_BY_REL_PATH = new Map(
  CAMP_TARGET_SCHEMA.map((field) => [field.path.slice(ITEMS_ARRAY_PREFIX.length), field] as const),
);

/** The per-session time leaves, relative to one item. */
const SESSION_TIME_PATHS = new Set(["schedules[].startTime", "schedules[].endTime"]);

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

/** A real calendar date written `YYYY-MM-DD` (optionally followed by a time). "June 1" is not one: it has no year. */
function isIsoCalendarDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

/**
 * Check one proposed value against its schema entry's declared type. Traverse
 * annotates a mismatch (`evidenceMatch.schema`) but never drops the proposal,
 * and the structured-output schema types every value as a plain string, so a
 * provider can return any text for an enum, or "June 1" for a date. This is
 * where such a value is refused: it is never part of a proposed change, and it
 * is reported (see `AssembledItem.refusedValues`).
 *
 * A date must also have its year in the excerpt it cites.
 *
 * An enum is matched ignoring case and surrounding space and returned in its
 * declared spelling ("Instagram" is `instagram`); nothing looser than that.
 */
function screenValue(relPath: string, value: unknown, excerpt: string): { ok: true; value: unknown } | { ok: false; why: string } {
  const field = SCHEMA_BY_REL_PATH.get(relPath);
  if (!field) return { ok: true, value };
  if (SESSION_TIME_PATHS.has(relPath)) {
    // A session time is a clock time with its half of the day, and the text
    // it cites must state that time (session-time.ts); the time-of-day
    // analogue of the year-in-quote rule for dates below.
    const canonical = canonicalTime(value);
    if (canonical === null) return { ok: false, why: "not a clock time with its am/pm" };
    return textStatesTime(canonical, excerpt)
      ? { ok: true, value: canonical }
      : { ok: false, why: "the time is not stated in the cited text" };
  }
  switch (field.type) {
    case "enum": {
      const allowed = field.enumValues ?? [];
      const wanted = String(value).trim().toLowerCase();
      const canonical = allowed.find((candidate) => candidate.toLowerCase() === wanted);
      return canonical === undefined
        ? { ok: false, why: `not one of the allowed values (${allowed.join(", ")})` }
        : { ok: true, value: canonical };
    }
    case "date":
      if (!isIsoCalendarDate(value)) return { ok: false, why: "not a full calendar date (YYYY-MM-DD)" };
      // A provider asked for YYYY-MM-DD will supply a year the text does not
      // state ("December 21" becomes this year, or next). The cited excerpt
      // must carry the year, or the date is a guess.
      return excerpt.includes((value as string).slice(0, 4))
        ? { ok: true, value }
        : { ok: false, why: "its year is not stated in the cited text" };
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : { ok: false, why: "not a number" };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, why: "not true or false" };
    default:
      return { ok: true, value };
  }
}

export interface FieldProposal {
  candidateValue: unknown;
  /** The provider's self-report, absent when it gave none (Traverse 2.0+). Never defaulted. */
  confidence?: number;
  excerpt: string;
  locator: string;
  extractor: string;
  /**
   * Set when `candidateValue` failed its schema type check (see `screenValue`);
   * holds why. The proposal keeps its place so positional pairing of the
   * other sub-fields is not shifted, but its value is never used.
   */
  refused?: string;
}

/** One reconstructed entry of an enum-array family (e.g. one campTypes[] tag). */
export interface EnumArrayEntry {
  value: string;
  confidence?: number;
  excerpt: string;
  locator: string;
}

export interface AssembledItem {
  /** the source item index (pathIndices[0], or 0 when the model didn't index). */
  itemIndex: number;
  /** bare scalar field -> its single proposal (e.g. "name", "city"). */
  scalars: Partial<Record<ItemFieldPath, FieldProposal>>;
  /** each entry is one age band, fully reconstructed from its own excerpt(s). `locator` is where `label` sits in the prepared text. */
  ageGroups: { minAge: number | null; maxAge: number | null; label: string; locator: string; confidence?: number }[];
  /**
   * each entry is one session, fully reconstructed from its own excerpt(s).
   * `label`/`locator` cite its dates. `startTime`/`endTime` are set only when
   * the page states both (each in the text it cites, see `screenValue`), and
   * `timeCitations` then holds that text: one entry per distinct excerpt.
   * A time the page does not state is null, never a default.
   */
  schedules: {
    startDate: string | null;
    endDate: string | null;
    startTime: string | null;
    endTime: string | null;
    timeCitations: { excerpt: string; locator: string }[];
    label: string;
    locator: string;
    confidence?: number;
  }[];
  /**
   * each entry is one price tier, fully reconstructed from its own excerpt(s).
   * A tier missing its amount or unit is never defaulted (a missing amount is
   * not 0, a missing unit is not PER_WEEK). If ANY tier on the item is
   * missing one, `pricing` is empty: approving a pricing change replaces the
   * camp's whole price list (review-apply deletes and re-inserts), so a
   * partial list would delete the tiers that could not be extracted.
   */
  pricing: { amount: number; unit: PricingUnit; label: string; locator: string; confidence?: number }[];
  /**
   * Values the provider proposed that failed their field's type check (an
   * enum member outside the allowed set, a date with no year), keyed by item
   * field (`campTypes`, `category`, `schedules`, ...). They are never part of
   * a proposed value; each is also an operator warning.
   */
  refusedValues: Record<string, string[]>;
  /**
   * Scalar fields for which the page states more than one distinct value
   * (Traverse 4.1 asks for one proposal per distinct value), with the values.
   * None of them is taken as the field's value: picking the first would hide
   * the disagreement from the reviewer. Each is also an operator warning.
   */
  conflictingValues: Record<string, string[]>;
  /**
   * Entries left out of a proposed list or object because another entry with
   * the same values was kept: a session on the same dates under another label,
   * a second URL for the same social platform. One sentence each, for the
   * review page. Exact repeats are not listed.
   */
  droppedEntries: string[];
  /**
   * Present when this one item carries more than one distinct `name`: the
   * page lists several programs and the provider did not separate them (the
   * structured-output schema only admits un-indexed paths, so no `items[N]`
   * index arrives). `names` are the programs seen. No single program's name
   * is taken as the item's name, and a scalar the programs disagree on is not
   * taken from any one of them (`withheldFields`); list fields combine every
   * program's entries.
   */
  multiProgram?: { names: string[]; withheldFields: string[] };
  /**
   * Notes an operator needs even when no proposal is created: each dropped
   * price tier, and the withheld pricing change. Also included in `warnings`.
   * Crawl pipelines copy these into the run's camp log.
   */
  operatorWarnings: string[];
  /** every distinct camp-type tag proposed for this item (enum-array family, not row objects). */
  campTypes: EnumArrayEntry[];
  /** every distinct category proposed for this item (enum-array family, not row objects). */
  categories: EnumArrayEntry[];
  /** every proposal that contributed to this item, for audit (rawExtraction). */
  allProposals: ExtractionProposal[];
  /** non-fatal notes, e.g. positional-pairing fallback used for an unindexed nested field. */
  warnings: string[];
}

function toFieldProposal(p: ExtractionProposal, relPath: string): FieldProposal {
  const screened = screenValue(relPath, p.candidateValue, p.provenance.excerpt);
  return {
    candidateValue: screened.ok ? screened.value : p.candidateValue,
    ...(screened.ok ? {} : { refused: screened.why }),
    ...(p.confidence === undefined ? {} : { confidence: p.confidence }),
    excerpt: p.provenance.excerpt,
    locator: p.provenance.locator,
    extractor: p.extractor,
  };
}

interface RelativeProposal {
  /** fieldPath with the "items[]." prefix stripped, e.g. "name" or "ageGroups[].minAge". */
  relPath: string;
  /** pathIndices[1] when present — the nested row (or enum-array slot) this belongs to. */
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
export function assignGlobalItemIndices(proposals: ExtractionProposal[]): {
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
    const fp = toFieldProposal(entry.proposal, entry.relPath);
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

/**
 * Reconstruct one enum-array family's entries (e.g. campTypes[]) within one
 * item, from its relative proposals. Unlike {@link assembleNestedRows}, each
 * entry is a single scalar value (no sub-fields) — so indexed proposals
 * (pathIndices[1] present) are keyed directly by that slot index, and
 * un-indexed proposals are appended in encounter order. Identical values
 * (a provider re-affirming the same tag across chunks, or emitting it twice
 * within one chunk) are de-duplicated, keeping the highest-confidence
 * occurrence, so the reconstructed array never carries a repeated tag.
 */
function assembleEnumArrayEntries(
  entries: RelativeProposal[]
): { rows: EnumArrayEntry[]; refused: FieldProposal[]; warnings: string[] } {
  const warnings: string[] = [];
  const indexedRows = new Map<number, FieldProposal>();
  const unindexedRows: FieldProposal[] = [];

  for (const entry of entries) {
    const fp = toFieldProposal(entry.proposal, entry.relPath);
    if (entry.subIndex !== undefined) {
      indexedRows.set(entry.subIndex, fp);
    } else {
      unindexedRows.push(fp);
    }
  }

  if (unindexedRows.length > 0) {
    warnings.push(
      `enum-array field had ${unindexedRows.length} un-indexed proposal(s) — appended in encounter order (still item-scoped, not cross-item)`
    );
  }

  const ordered: FieldProposal[] = [
    ...[...indexedRows.entries()].sort((a, b) => a[0] - b[0]).map(([, fp]) => fp),
    ...unindexedRows,
  ];

  const byValue = new Map<string, EnumArrayEntry>();
  for (const fp of ordered) {
    if (fp.refused) continue;
    const value = String(fp.candidateValue);
    const candidate: EnumArrayEntry = { value, ...(fp.confidence === undefined ? {} : { confidence: fp.confidence }), excerpt: fp.excerpt, locator: fp.locator };
    const existing = byValue.get(value);
    // A later duplicate replaces the kept one only when both reported a
    // confidence and the later one is higher; an unreported confidence is
    // not ranked as low or high.
    if (!existing || (candidate.confidence !== undefined && existing.confidence !== undefined && candidate.confidence > existing.confidence)) {
      byValue.set(value, candidate);
    }
  }

  return { rows: [...byValue.values()], refused: ordered.filter((fp) => fp.refused), warnings };
}

/** One citation per distinct excerpt, in order. */
function distinctCitations(parts: readonly FieldProposal[]): { excerpt: string; locator: string }[] {
  const seen = new Map<string, { excerpt: string; locator: string }>();
  for (const part of parts) {
    const key = `${part.excerpt}\u0000${part.locator}`;
    if (!seen.has(key)) seen.set(key, { excerpt: part.excerpt, locator: part.locator });
  }
  return [...seen.values()];
}

function rowExcerpt(row: Map<string, FieldProposal>): string {
  return [...row.values()][0]?.excerpt ?? "";
}

/** Locator of the same proposal {@link rowExcerpt} takes its excerpt from. */
function rowLocator(row: Map<string, FieldProposal>): string {
  return [...row.values()][0]?.locator ?? "";
}

/** Distinct values in first-seen order, compared case- and whitespace-insensitively; the first spelling is kept. */
function distinctValues(values: readonly unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (!seen.has(key)) seen.set(key, text);
  }
  return [...seen.values()];
}

/** The operator-facing sentence for {@link AssembledItem.multiProgram}. */
export function multiProgramWarning(multiProgram: { names: readonly string[]; withheldFields: readonly string[] }): string {
  const others = multiProgram.withheldFields.filter((field) => field !== "name");
  return `page lists ${multiProgram.names.length} programs (${multiProgram.names.map((name) => `"${name}"`).join(", ")}) that were not separated into items — the camp name is not proposed from any one program`
    + (others.length > 0 ? `; ${others.join(", ")} not proposed because the programs state different values` : "")
    + "; list fields combine every program's entries";
}

/** The operator-facing sentence for one entry of {@link AssembledItem.conflictingValues}. */
export function conflictingValuesWarning(field: string, values: readonly string[]): string {
  return `${field}: the page states ${values.length} different values (${values.map((value) => `"${value}"`).join(", ")}) — none is proposed; a reviewer must choose`;
}

/** Keep the first row for each key; report how many repeats were dropped. */
function dedupeRows<T extends { label: string }>(
  rows: readonly T[],
  key: (row: T) => string,
): { rows: T[]; dropped: number; droppedLabels: { kept: string; dropped: string }[] } {
  const seen = new Map<string, T>();
  const kept: T[] = [];
  const droppedLabels: { kept: string; dropped: string }[] = [];
  let dropped = 0;
  for (const row of rows) {
    const k = key(row);
    const first = seen.get(k);
    if (first) {
      dropped++;
      // Same values under a different label is a row a reviewer may want
      // (another program's session on the same dates), so it is reported.
      if (first.label !== row.label) droppedLabels.push({ kept: first.label, dropped: row.label });
      continue;
    }
    seen.set(k, row);
    kept.push(row);
  }
  return { rows: kept, dropped, droppedLabels };
}

/**
 * One session listed more than once (a summary line and a card) is one
 * session: rows on the same dates are merged. A time stated by one copy is
 * the session's time. Rows on the same dates with DIFFERENT stated times are
 * different sessions (a morning and an afternoon session), one each; a copy
 * with no time is then not assigned to either.
 */
function mergeSessionCopies(rows: readonly AssembledItem["schedules"][number][]): {
  rows: AssembledItem["schedules"][number][];
  dropped: number;
  droppedLabels: { kept: string; dropped: string }[];
} {
  const groups = new Map<string, AssembledItem["schedules"][number][]>();
  for (const row of rows) {
    const key = JSON.stringify([row.startDate, row.endDate]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const kept: AssembledItem["schedules"][number][] = [];
  const droppedLabels: { kept: string; dropped: string }[] = [];
  let dropped = 0;
  for (const copies of groups.values()) {
    const timed = new Map<string, AssembledItem["schedules"][number]>();
    for (const row of copies) {
      if (row.startTime !== null && row.endTime !== null && !timed.has(`${row.startTime}|${row.endTime}`)) timed.set(`${row.startTime}|${row.endTime}`, row);
    }
    const keep = timed.size > 0 ? [...timed.values()] : [copies[0]!];
    kept.push(...keep);
    for (const row of copies) {
      if (keep.includes(row)) continue;
      dropped++;
      if (row.label !== keep[0]!.label) droppedLabels.push({ kept: keep[0]!.label, dropped: row.label });
    }
  }
  // Keep the page's order.
  kept.sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  return { rows: kept, dropped, droppedLabels };
}

function parsePricingUnit(fp: FieldProposal | undefined): PricingUnit | null {
  const value = fp && !fp.refused ? fp.candidateValue : undefined;
  return typeof value === "string" && (PRICING_UNIT_VALUES as readonly string[]).includes(value)
    ? (value as PricingUnit)
    : null;
}

function parsePricingAmount(fp: FieldProposal | undefined): number | null {
  const value = fp && !fp.refused ? fp.candidateValue : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A sub-field's value, or null when it is absent or was refused. */
function acceptedValue<T>(fp: FieldProposal | undefined): T | null {
  return fp && !fp.refused ? ((fp.candidateValue as T | undefined) ?? null) : null;
}

/**
 * Mean of a set of self-reported confidences, rounded to 2dp — or undefined
 * when the set is empty or any member reported none. Traverse 2.0 made
 * confidence optional; a mean over only the members that reported one would
 * present a number for values the provider never scored.
 */
export function meanReportedConfidence(values: readonly (number | undefined)[]): number | undefined {
  if (values.length === 0 || values.some((value) => value === undefined)) return undefined;
  const known = values as readonly number[];
  return Math.round((known.reduce((sum, value) => sum + value, 0) / known.length) * 100) / 100;
}

function withConfidence(confidence: number | undefined): { confidence?: number } {
  return confidence === undefined ? {} : { confidence };
}

function rowConfidence(row: Map<string, FieldProposal>): number | undefined {
  return meanReportedConfidence([...row.values()].map((value) => value.confidence));
}

/**
 * Attach a stated start and end time to each dated session row, or none.
 *
 * A pair is a time only when its start and end are cited from the SAME text,
 * and that text states exactly one time range, this one, with its end after
 * its start (session-time.ts). "Drop-off 8, camp 9-3, pickup 5" does not
 * state 8-5; "half day 9-12 / full day 9-3" does not say which; a start from
 * the morning camp's line and an end from the afternoon's is not a range the
 * page states.
 *
 * Traverse drops a repeated proposal (same field, value and cited span), and
 * without item indices a time can arrive on the wrong session's row. So a
 * time is placed by where its cited text is, never by the row it arrived on.
 * With the prepared page text, "where" is the LINE (a list item, a table
 * row): a time on the same line as exactly one session's dates is that
 * session's time; on the lines of several sessions it is refused. A time on
 * no session's line is the camp's daily time only when
 *  - its line states no date and names no session ("Week 2"),
 *  - it sits outside the run of session lines (before the first or after the
 *    last), not between them, where it may belong to the session above it,
 *  - and it is the page's only such time text (one cited span).
 * It then applies to each session without a time of its own. Without the
 * page text only the cited spans are compared, and no daily time is applied.
 * When unsure, the time is left out; nothing is filled in from a usual day.
 */
function assignSessionTimes(
  rows: readonly { row: Map<string, FieldProposal>; dateParts: Map<string, FieldProposal>; label: string }[],
  undatedTimes: readonly Map<string, FieldProposal>[],
  preparedText: string | undefined,
): { times: ({ start: FieldProposal; end: FieldProposal } | null)[]; notes: string[] } {
  type Pair = { start: FieldProposal; end: FieldProposal };
  const notes: string[] = [];
  const pairOf = (row: Map<string, FieldProposal>, label: string): Pair | null => {
    const start = row.get("startTime");
    const end = row.get("endTime");
    if (!start && !end) return null;
    if (!start || !end || start.refused || end.refused) {
      notes.push(`"${label}": ${start?.refused ?? end?.refused ?? `no ${start ? "end" : "start"} time was extracted`}`);
      return null;
    }
    if (start.excerpt !== end.excerpt || start.locator !== end.locator) {
      notes.push(`"${label}": the start and end time are cited from different text ("${start.excerpt}", "${end.excerpt}")`);
      return null;
    }
    if (!textStatesOnlyRange(start.candidateValue, end.candidateValue, start.excerpt)) {
      notes.push(`"${start.excerpt}": does not state ${start.candidateValue}–${end.candidateValue} as its one time range`);
      return null;
    }
    return { start, end };
  };
  const stated = [
    ...rows.map(({ row, label }) => pairOf(row, label)),
    ...undatedTimes.map((row) => pairOf(row, rowExcerpt(row))),
  ].filter((pair): pair is Pair => pair !== null);

  /** The span a locator's text sits in: its whole line(s) with the page text, else the cited span. */
  const contextOf = (locator: string): [number, number] | null => {
    const m = /^chars:(\d+)-(\d+)$/.exec(locator);
    if (!m) return null;
    const [from, to] = [Number(m[1]), Number(m[2])];
    if (preparedText === undefined) return [from, to];
    const lineStart = preparedText.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
    const nextBreak = preparedText.indexOf("\n", Math.max(from, to - 1));
    return [from === 0 ? 0 : lineStart, nextBreak < 0 ? preparedText.length : nextBreak];
  };
  const overlap = (a: [number, number] | null, b: [number, number] | null) => a !== null && b !== null && a[0] < b[1] && b[0] < a[1];
  const sessionContexts = rows.map(({ dateParts }) => [...dateParts.values()].map((fp) => contextOf(fp.locator)).filter((c): c is [number, number] => c !== null));
  const allSessionContexts = sessionContexts.flat();
  const firstSessionStart = Math.min(...allSessionContexts.map((c) => c[0]));
  const lastSessionEnd = Math.max(...allSessionContexts.map((c) => c[1]));

  const own = new Map<number, Pair>();
  const conflicted = new Set<number>();
  const general = new Map<string, Pair>();
  for (const pair of stated) {
    const context = contextOf(pair.start.locator);
    const covering = sessionContexts.flatMap((contexts, index) => (contexts.some((c) => overlap(context, c)) ? [index] : []));
    if (covering.length === 1) {
      const index = covering[0]!;
      const existing = own.get(index);
      if (existing && (existing.start.candidateValue !== pair.start.candidateValue || existing.end.candidateValue !== pair.end.candidateValue)) {
        conflicted.add(index);
      } else {
        own.set(index, pair);
      }
      continue;
    }
    if (covering.length > 1) {
      notes.push(`"${pair.start.excerpt}": the cited text gives the times of several sessions at once; which is which is not settled by it`);
      continue;
    }
    const lineText = context && preparedText !== undefined ? preparedText.slice(context[0], context[1]) : null;
    const outsideSessions = context !== null && (context[1] <= firstSessionStart || context[0] >= lastSessionEnd);
    if (lineText !== null && outsideSessions && !statesADate(lineText) && !SESSION_NAME_RE.test(lineText)) {
      if (!general.has(pair.start.locator)) general.set(pair.start.locator, pair);
    } else {
      notes.push(`"${pair.start.excerpt}": the cited time is not in any one session's own text`);
    }
  }
  for (const index of conflicted) {
    own.delete(index);
    notes.push(`"${rows[index]!.label}": the page states different times for this session`);
  }
  if (general.size > 1) {
    notes.push(`the page states ${general.size} separate daily times (${[...general.values()].map((pair) => `${pair.start.candidateValue}–${pair.end.candidateValue}`).join(", ")}); none is applied to every session`);
  }
  const everySession = general.size === 1 ? [...general.values()][0]! : null;
  const times = rows.map((_row, index) => (conflicted.has(index) ? null : own.get(index) ?? everySession));
  return { times, notes };
}

const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;
const NUMERIC_DATE_RE = /\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/;
/** "Week 2", "Session 1", "Wk 3", "Term B": text that names one session. */
// A separator is required ("sessions", "weeks" do not name one), and a
// number followed by a time ("week 9 am") is a time, not a session number.
const SESSION_NAME_RE = /\b(week|wk|session|term|block)\s+(?:#\s*)?(?:\d+(?![\d:]|\s*[ap]\.?\s?m\b)|[a-z](?![\w.])|(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)/i;

/** Whether a text states a calendar date ("June 14", "June 14th", "14 June", "6/14", "2027-06-14"). */
function statesADate(text: string): boolean {
  return MONTH_DAY_RE.test(text) || NUMERIC_DATE_RE.test(text);
}

/** Whether two `chars:<start>-<end>` locators overlap. False when either cannot be parsed. */
function spansOverlap(a: string, b: string): boolean {
  const pa = /^chars:(\d+)-(\d+)$/.exec(a);
  const pb = /^chars:(\d+)-(\d+)$/.exec(b);
  if (!pa || !pb) return false;
  return Number(pa[1]) < Number(pb[2]) && Number(pb[1]) < Number(pa[2]);
}

/**
 * Group a full traverse extraction's proposals into one {@link AssembledItem}
 * per source item, ordered by item index.
 */
export function assembleItems(
  proposals: ExtractionProposal[],
  options: {
    /**
     * The prepared text the proposals' `chars:` locators point into. Session
     * times are placed by the line they are on; without it only the cited
     * spans are compared and no daily time is applied to every session.
     */
    preparedText?: string;
  } = {},
): AssembledItem[] {
  const { groups: byItem, chunkBoundaryIndices } = groupByItemIndex(proposals);
  const items: AssembledItem[] = [];

  for (const [itemIndex, entries] of [...byItem.entries()].sort((a, b) => a[0] - b[0])) {
    const scalars: Partial<Record<ItemFieldPath, FieldProposal>> = {};
    const warnings: string[] = [];
    const operatorWarnings: string[] = [];
    const refusedValues: Record<string, string[]> = {};
    const refusalWarnings: string[] = [];
    const droppedEntries: string[] = [];
    const conflictingValues: Record<string, string[]> = {};
    /**
     * Record every refused proposal under `field`, with one warning per
     * distinct reason. `warn: false` for a list family whose dropped rows are
     * already reported (the refusal would only repeat that note).
     */
    const refuse = (field: string, refused: readonly FieldProposal[], warn = true) => {
      if (refused.length === 0) return;
      const values = distinctValues(refused.map((fp) => fp.candidateValue));
      refusedValues[field] = distinctValues([...(refusedValues[field] ?? []), ...values]);
      if (!warn) return;
      for (const why of distinctValues(refused.map((fp) => fp.refused))) {
        const affected = distinctValues(refused.filter((fp) => fp.refused === why).map((fp) => fp.candidateValue));
        refusalWarnings.push(`${field}: ${affected.map((value) => `"${value}"`).join(", ")} not proposed — ${why}`);
      }
    };
    const refusedIn = (rows: readonly Map<string, FieldProposal>[]) =>
      rows.flatMap((row) => [...row.values()].filter((fp) => fp.refused));
    const allProposals: ExtractionProposal[] = [];

    if (chunkBoundaryIndices.has(itemIndex)) {
      warnings.push(
        `item index ${itemIndex} was rebased across a traverse chunk boundary (the provider's raw pathIndices[0] restarted at 0 for a later chunk) — grouped via a decreasing-index heuristic, not a chunk id traverse itself exposes; verify this item is not merged with an unrelated one`
      );
    }

    const programNames = distinctValues(entries.filter((e) => e.relPath === "name").map((e) => e.proposal.candidateValue));
    const collapsedPrograms = programNames.length > 1;
    const withheldProgramFields: string[] = [];

    for (const scalarPath of SCALAR_SCHEMA_PATHS) {
      const matches = entries.filter((e) => e.relPath === scalarPath).map((e) => toFieldProposal(e.proposal, e.relPath));
      if (matches.length === 0) continue;
      refuse(scalarPath, matches.filter((fp) => fp.refused));
      const valid = matches.filter((fp) => !fp.refused);
      if (valid.length === 0) continue;
      // Several programs collapsed into this item: a value is the item's only
      // when every program states the same one. The name never is.
      if (collapsedPrograms && (scalarPath === "name" || distinctValues(valid.map((fp) => fp.candidateValue)).length > 1)) {
        withheldProgramFields.push(scalarPath);
        continue;
      }
      // One program, several distinct values for one field: a conflict the
      // reviewer must see, not a choice to make for them.
      const stated = distinctValues(valid.map((fp) => fp.candidateValue));
      if (stated.length > 1) {
        conflictingValues[scalarPath] = stated;
        operatorWarnings.push(conflictingValuesWarning(scalarPath, stated));
        continue;
      }
      scalars[scalarPath] = valid[0];
    }

    const ageGroupEntries = entries.filter((e) => e.relPath.startsWith("ageGroups[]."));
    const scheduleEntries = entries.filter((e) => e.relPath.startsWith("schedules[]."));
    const pricingEntries = entries.filter((e) => e.relPath.startsWith("pricing[]."));

    const ageGroupResult = assembleNestedRows(ageGroupEntries, NESTED_ARRAY_FIELDS["ageGroups[]"]);
    const scheduleResult = assembleNestedRows(scheduleEntries, NESTED_ARRAY_FIELDS["schedules[]"]);
    const pricingResult = assembleNestedRows(pricingEntries, NESTED_ARRAY_FIELDS["pricing[]"]);
    warnings.push(...ageGroupResult.warnings, ...scheduleResult.warnings, ...pricingResult.warnings);
    refuse("ageGroups", refusedIn(ageGroupResult.rows));
    refuse("schedules", refusedIn(scheduleResult.rows), false);
    refuse("pricing", refusedIn(pricingResult.rows), false);

    // A provider may report the same band, session or tier more than once
    // (a repeated card, or the same text read by two overlapping chunks).
    // Approving a list writes one row per entry, so repeats are dropped here.
    const ageGroupRows = dedupeRows(
      ageGroupResult.rows
        .map((row) => ({
          minAge: acceptedValue<number>(row.get("minAge")),
          maxAge: acceptedValue<number>(row.get("maxAge")),
          label: rowExcerpt(row),
          locator: rowLocator(row),
          ...withConfidence(rowConfidence(row)),
        }))
        .filter((row) => row.minAge !== null || row.maxAge !== null),
      (row) => JSON.stringify([row.minAge, row.maxAge]),
    );
    const ageGroups = ageGroupRows.rows;

    // A session is its dates. One with no usable start date, or an unusable
    // end date, is dropped, and then the whole change is withheld: approving a
    // session list reconciles the camp's sessions against it, so a partial
    // list would archive the sessions that could not be extracted.
    //
    // A session's time never decides whether the session is proposed: it is
    // attached by `assignSessionTimes` only when the page states it, and is
    // otherwise left out (null), which leaves the time requirement open.
    const datedRows: { row: Map<string, FieldProposal>; dateParts: Map<string, FieldProposal>; startDate: string; endDate: string | null; label: string }[] = [];
    const droppedScheduleLabels: string[] = [];
    const undatedTimes: Map<string, FieldProposal>[] = [];
    for (const row of scheduleResult.rows) {
      if (row.size === 0) continue;
      const dateParts = new Map([...row].filter(([subField]) => subField === "startDate" || subField === "endDate"));
      if (dateParts.size === 0) {
        undatedTimes.push(row);
        continue;
      }
      const label = rowExcerpt(dateParts);
      const startDate = acceptedValue<string>(row.get("startDate"));
      const endDate = acceptedValue<string>(row.get("endDate"));
      if (startDate === null || row.get("endDate")?.refused) {
        droppedScheduleLabels.push(label);
        continue;
      }
      datedRows.push({ row, dateParts, startDate, endDate, label });
    }
    const timed = assignSessionTimes(datedRows, undatedTimes, options.preparedText);
    if (timed.notes.length > 0) {
      operatorWarnings.push(
        `${timed.notes.length} session time${timed.notes.length === 1 ? "" : "s"} not proposed (e.g. ${timed.notes.slice(0, 3).join("; ")}) — a time the page does not state for that session is left out, and the session is proposed without it`
      );
    }
    const completeSchedules: AssembledItem["schedules"] = datedRows.map((dated, index) => {
      const time = timed.times[index];
      return {
        startDate: dated.startDate,
        endDate: dated.endDate,
        startTime: time ? (time.start.candidateValue as string) : null,
        endTime: time ? (time.end.candidateValue as string) : null,
        timeCitations: time ? distinctCitations([time.start, time.end]) : [],
        label: dated.label,
        locator: rowLocator(dated.dateParts),
        ...withConfidence(rowConfidence(dated.row)),
      };
    });
    const scheduleRows = mergeSessionCopies(completeSchedules);
    const droppedSchedules = droppedScheduleLabels.length;
    if (droppedSchedules > 0) {
      // One note for the family, not one per row: a listing page can carry dozens.
      const examples = distinctValues(droppedScheduleLabels).slice(0, 3).map((label) => `"${label}"`).join(", ");
      operatorWarnings.push(
        `${droppedSchedules} session entr${droppedSchedules === 1 ? "y" : "ies"} dropped (e.g. ${examples}): no full calendar date (YYYY-MM-DD) was extracted — a date the page does not state in full is not emitted`
      );
    }
    if (droppedSchedules > 0 && scheduleRows.rows.length > 0) {
      operatorWarnings.push(
        `sessions change withheld: ${scheduleRows.rows.length} complete session(s) not proposed because ${droppedSchedules} session(s) could not be fully extracted — approving a partial list would archive the camp's other sessions`
      );
    }
    const schedules = droppedSchedules > 0 ? [] : scheduleRows.rows;

    const complete: AssembledItem["pricing"] = [];
    let droppedPricing = 0;
    for (const row of pricingResult.rows) {
      if (row.size === 0) continue;
      const label = rowExcerpt(row);
      const locator = rowLocator(row);
      const amount = parsePricingAmount(row.get("amount"));
      const unit = parsePricingUnit(row.get("unit"));
      if (amount === null || unit === null) {
        droppedPricing++;
        const missing = [amount === null ? "amount" : null, unit === null ? "unit" : null].filter(Boolean).join(" and ");
        operatorWarnings.push(`pricing entry "${label}" dropped: no ${missing} was extracted — a price the page does not state is not emitted`);
        continue;
      }
      complete.push({ amount, unit, label, locator, ...withConfidence(rowConfidence(row)) });
    }
    const pricingRows = dedupeRows(complete, (row) => JSON.stringify([row.amount, row.unit, row.label]));
    for (const [family, result] of [["ageGroups", ageGroupRows], ["schedules", scheduleRows], ["pricing", pricingRows]] as const) {
      if (result.dropped > 0) warnings.push(`${family}: ${result.dropped} repeated entr${result.dropped === 1 ? "y" : "ies"} dropped`);
      for (const pair of result.droppedLabels) {
        droppedEntries.push(`${family}: "${pair.dropped}" was left out because it has the same values as "${pair.kept}"`);
      }
    }
    if (droppedPricing > 0 && pricingRows.rows.length > 0) {
      operatorWarnings.push(
        `pricing change withheld: ${pricingRows.rows.length} complete tier(s) (${pricingRows.rows.map((p) => `"${p.label}"`).join(", ")}) not proposed because ${droppedPricing} tier(s) could not be fully extracted — approving a partial list would delete the camp's other price tiers`
      );
    }
    const pricing = droppedPricing > 0 ? [] : pricingRows.rows;

    const enumArrayResults: Record<EnumArraySchemaPath, EnumArrayEntry[]> = {
      campTypes: [],
      categories: [],
    };
    for (const enumField of ENUM_ARRAY_SCHEMA_PATHS) {
      const fieldEntries = entries.filter((e) => e.relPath === `${enumField}[]`);
      const result = assembleEnumArrayEntries(fieldEntries);
      refuse(enumField, result.refused);
      // The list replaces the stored one when approved. With any member
      // refused, the remainder is not the page's list, so nothing is proposed.
      if (result.refused.length > 0) {
        if (result.rows.length > 0) {
          operatorWarnings.push(
            `${enumField} change withheld: ${result.rows.map((row) => `"${row.value}"`).join(", ")} not proposed because other value(s) for this list were not valid — approving a partial list would replace the stored one`
          );
        }
      } else {
        enumArrayResults[enumField] = result.rows;
      }
      warnings.push(...result.warnings);
    }

    // socialLinks[] rows fold into the one `{ platform: url }` object the Camp
    // column stores. A row needs both halves, and a platform outside the
    // allowed set is refused like any other enum value.
    const socialResult = assembleNestedRows(
      entries.filter((e) => e.relPath.startsWith("socialLinks[].")),
      NESTED_ARRAY_FIELDS["socialLinks[]"],
    );
    warnings.push(...socialResult.warnings);
    refuse("socialLinks", refusedIn(socialResult.rows));
    const socialLinks: Record<string, string> = {};
    const socialProposals: FieldProposal[] = [];
    for (const row of socialResult.rows) {
      const platform = acceptedValue<string>(row.get("platform"));
      const url = row.get("url");
      if (row.get("platform")?.refused) continue;
      if (platform === null || !url || typeof url.candidateValue !== "string" || !url.candidateValue.trim()) {
        if (row.size > 0) warnings.push(`socialLinks entry "${rowExcerpt(row)}" dropped: it needs both a platform and a url`);
        continue;
      }
      if (platform in socialLinks) {
        if (socialLinks[platform] !== url.candidateValue.trim()) {
          droppedEntries.push(`socialLinks: a second ${platform} link (${url.candidateValue.trim()}) was left out; ${socialLinks[platform]} was kept`);
        }
        continue;
      }
      socialLinks[platform] = url.candidateValue.trim();
      socialProposals.push(url);
    }
    if (socialProposals.length > 0) {
      scalars.socialLinks = {
        candidateValue: socialLinks,
        ...withConfidence(meanReportedConfidence(socialProposals.map((fp) => fp.confidence))),
        excerpt: socialProposals[0].excerpt,
        locator: socialProposals[0].locator,
        extractor: socialProposals[0].extractor,
      };
    }
    operatorWarnings.push(...refusalWarnings);

    const multiProgram = collapsedPrograms ? { names: programNames, withheldFields: withheldProgramFields } : undefined;
    if (multiProgram) operatorWarnings.push(multiProgramWarning(multiProgram));
    warnings.push(...operatorWarnings);

    for (const e of entries) allProposals.push(e.proposal);

    items.push({
      itemIndex,
      scalars,
      ageGroups,
      schedules,
      pricing,
      campTypes: enumArrayResults.campTypes,
      categories: enumArrayResults.categories,
      allProposals,
      warnings,
      operatorWarnings,
      refusedValues,
      conflictingValues,
      droppedEntries,
      ...(multiProgram ? { multiProgram } : {}),
    });
  }

  return items;
}
