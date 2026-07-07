/**
 * lib/admin/claim-corroboration.ts — pure "exact corroboration" derivation
 * (campfit#51, Wave 1 Task 1.1, R2/AC2).
 *
 * Terminology: this module's "field claim" is a `FieldDiff` entry inside a
 * `PENDING` `CampChangeProposal.proposedChanges` — the "Candidate Claim" unit
 * named in `docs/contexts/trust-review-provenance/CONTEXT.md`, NOT a
 * `@kontourai/surface` `Claim`/`ClaimDefinition` ledger row (those only exist
 * after Review Apply — see `review-apply.ts`'s header comment and the plan's
 * "Terminology reconciliation" section).
 *
 * "Exact corroboration" is new vocabulary this issue introduces — no
 * persisted multi-source corroboration signal exists anywhere in campfit or
 * in `@kontourai/surface`'s own `VerificationPolicy.requiresCorroboration`
 * (unusable here: migration 012's `"SurfaceVerificationPolicy"` table has no
 * column for it — `lib/admin/claim-store.ts`'s `assertPolicySupported` fails
 * loud on it; extending that table is out of this slice's scope). Instead,
 * this derives corroboration from data already persisted and durable:
 * `CampChangeProposal` history for the same Camp.
 *
 * A field claim (`proposalId`, `field`) is exact-corroborated iff at least
 * one OTHER, independently-created `CampChangeProposal` for the SAME Camp
 * proposed the EXACT SAME value (string-trimmed equality / deep-equal
 * otherwise) for the SAME field, from a DIFFERENT, NON-NULL `crawlRunId` (a
 * genuinely separate crawl execution, not a retry within the same run —
 * this is what stops "re-crawl the same page twice in quick succession"
 * from gaming the signal: two rows sharing the same `crawlRunId` never
 * corroborate each other). Restricted, by convention, to `CAMP_SCALAR_FIELDS`
 * (`proposal-fields.ts`) by every caller — relation fields (`ageGroups`/
 * `schedules`/`pricing`) are out of scope for batch corroboration in this
 * slice (more complex reconciliation semantics); this function itself is
 * generic and does not enforce that restriction, so it stays independently
 * testable against any field name a caller passes.
 *
 * `crawlRunId: null` NEVER corroborates and NEVER can BE corroborated
 * (fixed post-review-HIGH-finding: a prior version treated two `null`-run
 * rows as "different enough" — wrong). `null` means unknown provenance, not
 * "a distinct run" — `entity-admin-repository.ts`'s `createCampProposal`
 * (the admin-assistant path) always inserts `crawlRunId: NULL`, so without
 * this rule two non-independent assistant-authored proposals for the same
 * Camp/field/value (e.g. the same assistant session re-run, or a human
 * copy-pasting the same correction twice) would fake "exact corroboration"
 * of each other and become batch-acceptable — corroboration is supposed to
 * mean "two INDEPENDENT observations agree," and `null` carries no evidence
 * of independence either way. A `null`-run proposal can still be reviewed
 * (via the existing single-proposal `applyProposalReview` flow) — it is
 * simply never eligible for the batch-accept fast path this signal gates.
 * This is the strictest of the two readings the plan left open (null+null
 * "unproven independence" vs. null+non-null "one side has zero
 * provenance") — both default to NOT corroborating, on purpose: unknown
 * provenance can never anchor an independence claim, regardless of what the
 * other side's provenance looks like.
 *
 * Named limitation (recorded, not hidden): two crawls of the SAME
 * `sourceUrl` (the camp's own site, re-fetched on a later scheduled run)
 * count as "corroborating" under this rule even though they are not
 * independent *sources* in the sense "multiple sources agree" evokes — they
 * are independent *observations in time* of the same source. This is the
 * cheapest honest signal the current data model supports. The evidence
 * record captures whether the corroborating observation shared the same
 * `sourceUrl` (`sameSourceUrl`) so a future, stricter policy can filter on it
 * without re-deriving anything — informational, NOT a gate on `exact`.
 */
import type { ProposedChanges } from './types';

export interface FieldCorroboration {
  field: string;
  value: unknown;
  exact: boolean;
  corroboratingProposalIds: string[];
  corroboratingSourceUrls: string[];
  /** True iff any corroborating row shares the target's own `sourceUrl` — informational, not gating. */
  sameSourceUrl: boolean;
}

/** One `CampChangeProposal` history row for the same Camp, as read by `getCampProposalHistoryBatch`. */
export interface ProposalHistoryRow {
  id: string;
  proposedChanges: ProposedChanges;
  sourceUrl: string;
  crawlRunId: string | null;
  createdAt: string;
}

function normalizeForComparison(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function valuesMatch(a: unknown, b: unknown): boolean {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (typeof normalizedA === 'string' && typeof normalizedB === 'string') {
    return normalizedA === normalizedB;
  }
  return JSON.stringify(normalizedA) === JSON.stringify(normalizedB);
}

/**
 * Derives exact corroboration for one field claim (`targetProposalId`,
 * `field`) against a (caller-supplied) history of other proposals for the
 * SAME Camp. `history` may include the target proposal's own row — it is
 * explicitly excluded by id — and may include proposals from OTHER camps;
 * this function does not itself filter by camp, since the caller
 * (`getCampProposalHistoryBatch`) already scopes `history` per-camp.
 */
export function deriveFieldCorroboration(params: {
  targetProposalId: string;
  targetCrawlRunId: string | null;
  field: string;
  history: readonly ProposalHistoryRow[];
}): FieldCorroboration {
  const { targetProposalId, targetCrawlRunId, field, history } = params;

  const targetDiff = history.find((row) => row.id === targetProposalId)?.proposedChanges[field];
  const targetValue = targetDiff?.new;
  const targetSourceUrl = history.find((row) => row.id === targetProposalId)?.sourceUrl;

  const corroboratingProposalIds: string[] = [];
  const corroboratingSourceUrls: string[] = [];

  for (const row of history) {
    if (row.id === targetProposalId) continue;
    const diff = row.proposedChanges[field];
    if (!diff) continue;
    // Null crawlRunId (either side) never corroborates — see this module's
    // header comment for the full rationale. A same-run (non-null, equal)
    // pair is excluded for the pre-existing reason (same-crawl retry).
    if (row.crawlRunId === null || targetCrawlRunId === null) continue;
    if (row.crawlRunId === targetCrawlRunId) continue;
    if (!valuesMatch(diff.new, targetValue)) continue;

    corroboratingProposalIds.push(row.id);
    corroboratingSourceUrls.push(row.sourceUrl);
  }

  return {
    field,
    value: targetValue,
    exact: corroboratingProposalIds.length > 0,
    corroboratingProposalIds,
    corroboratingSourceUrls,
    sameSourceUrl: corroboratingSourceUrls.some((sourceUrl) => sourceUrl === targetSourceUrl),
  };
}
