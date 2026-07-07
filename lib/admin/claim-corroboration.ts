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
 * otherwise) for the SAME field, from a DIFFERENT `crawlRunId` (a genuinely
 * separate crawl execution, not a retry within the same run — this is what
 * stops "re-crawl the same page twice in quick succession" from gaming the
 * signal: two rows sharing the same `crawlRunId` never corroborate each
 * other). Restricted, by convention, to `CAMP_SCALAR_FIELDS`
 * (`proposal-fields.ts`) by every caller — relation fields (`ageGroups`/
 * `schedules`/`pricing`) are out of scope for batch corroboration in this
 * slice (more complex reconciliation semantics); this function itself is
 * generic and does not enforce that restriction, so it stays independently
 * testable against any field name a caller passes.
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
    if (row.crawlRunId !== null && row.crawlRunId === targetCrawlRunId) continue;
    // A `null` crawlRunId on BOTH sides is treated as "different" only in the
    // sense that neither is a same-run retry of the other — there is no run
    // id to compare, so two null-crawlRunId proposals for the same field/
    // value are NOT excluded here (they cannot be proven to be the same
    // run). This favors under- over over-excluding, matching the plan's
    // "conservative cut" framing for the corroboration signal itself.
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
