/**
 * app/api/admin/review/batch-accept/route.ts — POST the confidence-ranked
 * review queue's batch-accept action (campfit#51, Wave 3 Task 3.1, R2/R3/R4).
 *
 * `requireAdminAccess({ allowModerator: true })` — deliberately WITHOUT a
 * `communitySlug` — because a batch selection can span multiple Proposals
 * across multiple Camps/Communities in one request; there is no single
 * parent resource to authorize against up front (unlike a single-proposal
 * route, e.g. `[id]/approve/route.ts`, which resolves ONE communitySlug
 * before auth). The #93 lesson, applied here: every selected proposalId is
 * individually re-checked (bulk-resolved via `getProposalCommunitySlugs`,
 * one `ANY($1::text[])` query — review L5 fix, was one query per
 * proposalId) against `auth.access.communities`/`isAdmin` BEFORE any of its
 * selections ever reach `applyBatchAcceptedClaims` — an out-of-scope
 * selection is excluded (`excluded_scope`) and reported, not applied and
 * not fatal to the rest of the batch (mirrors the aggregator-discovery
 * onboard route's own per-item isolation convention).
 *
 * Corroboration is NOT re-checked here — `applyBatchAcceptedClaims` already
 * re-derives it server-side (see that function's own header comment); this
 * route's only additional gate is the per-selection community-scope check,
 * which happens strictly BEFORE calling into the apply layer (defense in
 * depth: `applyBatchAcceptedClaims`'s own `getProposal`/PENDING check
 * independently refuses to touch an unknown/out-of-scope proposal too, but
 * this route never even offers it the chance).
 *
 * The audit row (`recordBatchAcceptAudit`) captures the ranking/corroboration
 * context AT ACCEPT TIME — server-recomputed inside `applyBatchAcceptedClaims`,
 * never trusted from this request's body — so even a momentarily-stale UI
 * display cannot produce a stale audit record.
 *
 * REVIEW M4 FIX: an audit row is now written for EVERY non-empty
 * `selections` request, even one where EVERY selection ends up excluded
 * (100% `excluded_scope`/`excluded_not_corroborated`/etc, zero claims
 * applied) — previously the audit write was gated on `applyResult.claims.length
 * > 0`, so a fully-rejected batch (e.g. a scope-violation attempt) left NO
 * forensic trace at all. `appliedCount` (via `claims.length`) is simply `0`
 * on that row; `excluded` still records every reason. The HTTP response
 * shape/status for a fully-excluded batch is unchanged (still 200 with
 * per-selection `results`, since a partially-rejected batch was already
 * "successful" at the HTTP layer before this fix).
 */
import { NextResponse } from 'next/server';
import type { Pool } from 'pg';

import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunitySlugs } from '@/lib/admin/community-access';
import { getCampProposalHistoryBatch } from '@/lib/admin/review-repository';
import { applyBatchAcceptedClaims, type BatchAcceptOutcome, type BatchAcceptSelection } from '@/lib/admin/review-apply';
import {
  recordBatchAcceptAudit,
  type BatchAcceptExclusion,
  type BatchAcceptExclusionReason,
} from '@/lib/admin/batch-accept-audit-repository';

export const BATCH_ACCEPT_CRITERIA = 'exact-corroboration-v1';

export type BatchAcceptRouteStatus = BatchAcceptOutcome['status'] | 'excluded_scope';

export interface BatchAcceptRouteResult {
  proposalId: string;
  field: string;
  status: BatchAcceptRouteStatus;
  message?: string;
}

const EXCLUSION_REASON_BY_STATUS: Record<Exclude<BatchAcceptRouteStatus, 'applied'>, BatchAcceptExclusionReason> = {
  excluded_not_pending: 'not_pending',
  excluded_not_corroborated: 'not_corroborated',
  excluded_scope: 'out_of_scope',
  error: 'apply_error',
};

async function campIdsForProposals(pool: Pool, proposalIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (proposalIds.length === 0) return map;
  const { rows } = await pool.query<{ id: string; campId: string }>(
    `SELECT id, "campId" FROM "CampChangeProposal" WHERE id = ANY($1::text[])`,
    [proposalIds],
  );
  for (const row of rows) map.set(row.id, row.campId);
  return map;
}

function parseSelections(body: unknown): BatchAcceptSelection[] | null {
  const selections = (body as { selections?: unknown } | null)?.selections;
  if (!Array.isArray(selections)) return null;
  const parsed: BatchAcceptSelection[] = [];
  for (const entry of selections) {
    if (
      !entry || typeof entry !== 'object'
      || typeof (entry as { proposalId?: unknown }).proposalId !== 'string'
      || typeof (entry as { field?: unknown }).field !== 'string'
    ) {
      return null;
    }
    parsed.push({ proposalId: (entry as { proposalId: string }).proposalId, field: (entry as { field: string }).field });
  }
  return parsed;
}

export async function POST(request: Request) {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => null);
  const selections = parseSelections(body);
  if (!selections) {
    return NextResponse.json({ error: 'selections must be a non-empty array of { proposalId, field }' }, { status: 400 });
  }
  if (selections.length === 0) {
    return NextResponse.json({ error: 'selections must be a non-empty array of { proposalId, field }' }, { status: 400 });
  }

  const pool = getPool();

  // The #93 lesson: re-resolve and re-check EACH selected Proposal's
  // community individually — never a single up-front auth check against one
  // resource. An out-of-scope proposalId's selections are excluded here,
  // BEFORE ever reaching applyBatchAcceptedClaims.
  //
  // REVIEW L5 FIX: was one `getProposalCommunitySlug` query PER distinct
  // proposalId in a loop — batched into a single `ANY($1::text[])` query
  // (`getProposalCommunitySlugs`), matching this same file's own
  // `campIdsForProposals` bulk-lookup pattern below. Still re-checks EVERY
  // distinct proposalId individually in JS — this is a query-count
  // optimization only, not a relaxation of the #93 per-item scope check.
  const distinctProposalIds = Array.from(new Set(selections.map((s) => s.proposalId)));
  const scopeExcludedProposalIds = new Set<string>();
  if (!auth.access.isAdmin) {
    const communitySlugByProposal = await getProposalCommunitySlugs(distinctProposalIds);
    for (const proposalId of distinctProposalIds) {
      const communitySlug = communitySlugByProposal.get(proposalId) ?? null;
      if (!communitySlug || !auth.access.communities.includes(communitySlug)) {
        scopeExcludedProposalIds.add(proposalId);
      }
    }
  }

  const inScopeSelections = selections.filter((s) => !scopeExcludedProposalIds.has(s.proposalId));
  const scopeExclusionResults: BatchAcceptRouteResult[] = selections
    .filter((s) => scopeExcludedProposalIds.has(s.proposalId))
    .map((s) => ({
      proposalId: s.proposalId,
      field: s.field,
      status: 'excluded_scope' as const,
      message: 'Proposal is outside the requester\'s community scope.',
    }));

  const inScopeProposalIds = Array.from(new Set(inScopeSelections.map((s) => s.proposalId)));
  const campIdByProposal = await campIdsForProposals(pool, inScopeProposalIds);
  const campIds = Array.from(new Set(Array.from(campIdByProposal.values())));
  const historyByCamp = await getCampProposalHistoryBatch(pool, campIds);

  const applyResult = inScopeSelections.length > 0
    ? await applyBatchAcceptedClaims(pool, { selections: inScopeSelections, actor: auth.access.email, historyByCamp })
    : { outcomes: [], claims: [] };

  const results: BatchAcceptRouteResult[] = [
    ...scopeExclusionResults,
    ...applyResult.outcomes.map((outcome) => ({ ...outcome, status: outcome.status as BatchAcceptRouteStatus })),
  ];

  // REVIEW M4 FIX (was: `if (applyResult.claims.length > 0)`, so a batch
  // where EVERY selection was excluded — e.g. a moderator submitting a
  // selection entirely outside their community scope, or a batch that
  // turns out fully uncorroborated by the time it's re-checked
  // server-side — left NO audit trace at all. That is exactly the scenario
  // most worth an audit trail: a request attempting something (a
  // scope-violation attempt, a stale-client resubmission of an already-
  // resolved batch) that was correctly rejected in full. `results.length >
  // 0` is true whenever this line is reached (the route already 400s
  // above for an empty `selections` array, and every distinct selection
  // resolves to exactly one entry in `results` — either
  // `scopeExclusionResults` or `applyResult.outcomes` — so nothing here can
  // be selections.length > 0 yet results.length === 0). `recordBatchAcceptAudit`
  // already handles an empty `claims` array correctly (`appliedCount: 0` —
  // see that function's own INSERT), so this is a pure gate widening, no
  // schema/repository change needed.
  const excluded: BatchAcceptExclusion[] = results
    .filter((result): result is BatchAcceptRouteResult & { status: Exclude<BatchAcceptRouteStatus, 'applied'> } => result.status !== 'applied')
    .map((result) => ({
      proposalId: result.proposalId,
      field: result.field,
      reason: EXCLUSION_REASON_BY_STATUS[result.status],
      message: result.message,
    }));

  const auditId = results.length > 0
    ? await recordBatchAcceptAudit(pool, {
        performedBy: auth.access.email,
        criteria: BATCH_ACCEPT_CRITERIA,
        requestedCount: selections.length,
        claims: applyResult.claims,
        excluded,
      })
    : null;

  return NextResponse.json({ auditId, results });
}
