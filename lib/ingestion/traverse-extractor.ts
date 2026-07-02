/**
 * traverse-extractor.ts — PILOT wiring for @kontourai/traverse (Slice 1b).
 *
 * Schema-directed extraction path that runs ALONGSIDE the legacy selector
 * scrapers (lib/ingestion/scrapers/*.ts), never replacing them. It points
 * traverse's `extract()` at CAMP_TARGET_SCHEMA and maps the resulting
 * provenance-bearing PROPOSALS into CampFit's existing human-review sink —
 * the `ProposedChanges` / `createProposal` contract that the crawl pipeline
 * (lib/ingestion/crawl-pipeline.ts) already feeds the Survey review workflow.
 *
 * Discipline (ADR 0003-style): traverse emits PROPOSALS, never writes. This
 * module converts them to `ProposedChanges` and shapes the `createProposal`
 * arguments; it deliberately does NOT call the DB itself, so the same code is
 * exercised in CI with a stub provider and no database. The caller (a crawl
 * step, or a future promotion) is responsible for the actual `createProposal`
 * write after human review policy is applied.
 *
 * Provenance passthrough: traverse verifies each `excerpt` against the
 * prepared text and derives a `chars:<start>-<end>` locator. We carry the
 * excerpt into `FieldDiff.excerpt` (what the review UI already renders) and
 * preserve the full traverse proposal — including its verified locator — in
 * `rawExtraction`, so the audit trail keeps the exact offset provenance.
 */

import { extract } from "@kontourai/traverse";
import type {
  ExtractionProvider,
  ExtractionProposal,
  ExtractionResult,
} from "@kontourai/traverse";
import type { FieldDiff, ProposedChanges } from "@/lib/admin/types";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS, SCALAR_SCHEMA_PATHS } from "./traverse-schema";

export interface TraverseExtractOptions {
  /** Raw page content (html) or already-extracted text. */
  content: string;
  contentType?: "html" | "text";
  /** Stable source ref for provenance (usually the fetched URL). */
  sourceRef: string;
  /** Any ExtractionProvider — the Anthropic adapter in prod, a stub in tests. */
  provider: ExtractionProvider;
  maxContentChars?: number;
}

/**
 * Run traverse extraction for a single page. Thin wrapper that supplies the
 * camp schema + field hints. Never throws (traverse's `extract()` never
 * throws — any stage error is on `result.error` with empty proposals).
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

const SCALAR_PATH_SET = new Set<string>(SCALAR_SCHEMA_PATHS);

function normalizeScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim().toLowerCase();
}

/**
 * Map normalized traverse proposals into CampFit's `ProposedChanges` review
 * shape.
 *
 * - Scalar schema paths (name, description, category, …) are diffed against
 *   the current camp value: emitted only when the proposed value differs,
 *   with mode 'populate' when the current value is empty else 'update'.
 * - Nested array paths (schedules[].startDate, ageGroups[].minAge,
 *   pricing[].amount, …) are additive proposals — keyed by the traverse
 *   fieldPath, old=null, mode 'add_items' — since the pilot proposes new
 *   session/age/price rows for a reviewer to place.
 *
 * Every emitted `FieldDiff` carries the traverse `excerpt` and `sourceUrl`,
 * exactly like the legacy LLM extractor's diffs, so the Survey review UI
 * renders provenance unchanged.
 */
export function traverseProposalsToProposedChanges(
  proposals: ExtractionProposal[],
  current: Record<string, unknown> = {},
  sourceUrl = ""
): ProposedChanges {
  const changes: ProposedChanges = {};

  for (const p of proposals) {
    const isScalar = SCALAR_PATH_SET.has(p.fieldPath);

    if (isScalar) {
      const currentVal = current[p.fieldPath];
      if (normalizeScalar(currentVal) === normalizeScalar(p.candidateValue)) {
        continue; // no change — reviewer needn't see it
      }
      const isEmpty =
        currentVal === null || currentVal === undefined || currentVal === "";
      const diff: FieldDiff = {
        old: currentVal ?? null,
        new: p.candidateValue,
        confidence: p.confidence,
        mode: isEmpty ? "populate" : "update",
        excerpt: p.provenance.excerpt,
        ...(sourceUrl ? { sourceUrl } : {}),
      };
      changes[p.fieldPath] = diff;
    } else {
      // Additive nested/array proposal.
      const diff: FieldDiff = {
        old: null,
        new: p.candidateValue,
        confidence: p.confidence,
        mode: "add_items",
        excerpt: p.provenance.excerpt,
        ...(sourceUrl ? { sourceUrl } : {}),
      };
      changes[p.fieldPath] = diff;
    }
  }

  return changes;
}

/** Weighted-free mean confidence across a proposal set, clamped to 2dp. */
export function overallConfidence(proposals: ExtractionProposal[]): number {
  if (proposals.length === 0) return 0;
  const sum = proposals.reduce((s, p) => s + p.confidence, 0);
  return Math.round((sum / proposals.length) * 100) / 100;
}

export interface TraverseProposalRecord {
  sourceUrl: string;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  extractionModel: string;
  /** Full traverse audit payload — proposals (with verified locators), raw, warnings. */
  rawExtraction: Record<string, unknown>;
  /** Non-fatal notes surfaced from traverse (dropped/clamped proposals, truncation). */
  warnings: string[];
}

/**
 * Shape a complete `createProposal`-ready record from a traverse result. This
 * is the pilot's proof that traverse output ROUTES into the existing review
 * path: the returned object's fields line up 1:1 with
 * `createProposal({ sourceUrl, proposedChanges, overallConfidence,
 * extractionModel, rawExtraction, … })` (see lib/admin/review-repository.ts).
 * It does not perform the write — human-review policy owns that.
 */
export function buildTraverseProposalRecord(
  result: ExtractionResult,
  current: Record<string, unknown> = {},
  sourceUrl = ""
): TraverseProposalRecord {
  const proposedChanges = traverseProposalsToProposedChanges(
    result.proposals,
    current,
    sourceUrl
  );
  const extractionModel = result.raw?.model
    ? `traverse:${result.raw.model}`
    : "traverse:unknown";

  return {
    sourceUrl,
    proposedChanges,
    overallConfidence: overallConfidence(result.proposals),
    extractionModel,
    rawExtraction: {
      via: "traverse",
      extractedAt: result.extractedAt,
      proposals: result.proposals,
      raw: result.raw,
      warnings: result.warnings ?? [],
    },
    warnings: result.warnings ?? [],
  };
}
