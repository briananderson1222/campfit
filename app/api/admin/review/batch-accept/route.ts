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
 * individually re-resolved (`getProposalCommunitySlug`) and re-checked
 * against `auth.access.communities`/`isAdmin` BEFORE any of its selections
 * ever reach `applyBatchAcceptedClaims` — an out-of-scope selection is
 * excluded (`excluded_scope`) and reported, not applied and not fatal to the
 * rest of the batch (mirrors the aggregator-discovery onboard route's own
 * per-item isolation convention).
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
 */
import { NextResponse } from 'next/server';
import type { Pool } from 'pg';

import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunitySlug } from '@/lib/admin/community-access';
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
  const distinctProposalIds = Array.from(new Set(selections.map((s) => s.proposalId)));
  const scopeExcludedProposalIds = new Set<string>();
  for (const proposalId of distinctProposalIds) {
    if (auth.access.isAdmin) continue;
    const communitySlug = await getProposalCommunitySlug(proposalId);
    if (!communitySlug || !auth.access.communities.includes(communitySlug)) {
      scopeExcludedProposalIds.add(proposalId);
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

  let auditId: string | null = null;
  if (applyResult.claims.length > 0) {
    const excluded: BatchAcceptExclusion[] = results
      .filter((result): result is BatchAcceptRouteResult & { status: Exclude<BatchAcceptRouteStatus, 'applied'> } => result.status !== 'applied')
      .map((result) => ({
        proposalId: result.proposalId,
        field: result.field,
        reason: EXCLUSION_REASON_BY_STATUS[result.status],
        message: result.message,
      }));

    auditId = await recordBatchAcceptAudit(pool, {
      performedBy: auth.access.email,
      criteria: BATCH_ACCEPT_CRITERIA,
      requestedCount: selections.length,
      claims: applyResult.claims,
      excluded,
    });
  }

  return NextResponse.json({ auditId, results });
}
