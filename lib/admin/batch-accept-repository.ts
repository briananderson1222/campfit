import { getPool } from '@/lib/db';
import { getCampProposalHistoryBatch } from './review-repository';
import { applyBatchAcceptedClaims, type BatchAcceptOutcome, type BatchAcceptSelection } from './review-apply';
import { recordBatchAcceptAudit, type BatchAcceptExclusion, type BatchAcceptExclusionReason } from './batch-accept-audit-repository';
import { loadCampTrustDisplays } from './trust-display-read';
import type { TrustDisplay } from './trust-display';

export const BATCH_ACCEPT_CRITERIA = 'exact-corroboration-v1';
export type BatchAcceptRouteStatus = BatchAcceptOutcome['status'] | 'excluded_scope';
export interface BatchAcceptRouteResult {
  proposalId: string; field: string; status: BatchAcceptRouteStatus; message?: string; receipt?: TrustDisplay;
}
const EXCLUSION_REASON_BY_STATUS: Record<Exclude<BatchAcceptRouteStatus, 'applied'>, BatchAcceptExclusionReason> = {
  excluded_not_pending: 'not_pending', excluded_not_corroborated: 'not_corroborated',
  excluded_scope: 'out_of_scope', error: 'apply_error',
};

export async function applyAuthorizedBatchAccept(input: {
  inScopeSelections: BatchAcceptSelection[]; scopeExclusionResults: BatchAcceptRouteResult[];
  actor: string; requestedCount: number; criteria: string;
}): Promise<{ auditId: string | null; results: BatchAcceptRouteResult[] }> {
  const pool = getPool();
  const proposalIds = Array.from(new Set(input.inScopeSelections.map((selection) => selection.proposalId)));
  const campIdByProposal = new Map<string, string>();
  if (proposalIds.length > 0) {
    const { rows } = await pool.query<{ id: string; campId: string }>(
      `SELECT id, "campId" FROM "CampChangeProposal" WHERE id = ANY($1::text[])`, [proposalIds],
    );
    for (const row of rows) campIdByProposal.set(row.id, row.campId);
  }
  const historyByCamp = await getCampProposalHistoryBatch(pool, Array.from(new Set(campIdByProposal.values())));
  const applyResult = input.inScopeSelections.length > 0
    ? await applyBatchAcceptedClaims(pool, { selections: input.inScopeSelections, actor: input.actor, historyByCamp })
    : { outcomes: [], claims: [] };
  const results: BatchAcceptRouteResult[] = [
    ...input.scopeExclusionResults,
    ...applyResult.outcomes.map((outcome) => ({ ...outcome, status: outcome.status as BatchAcceptRouteStatus })),
  ];
  const excluded: BatchAcceptExclusion[] = results
    .filter((result): result is BatchAcceptRouteResult & { status: Exclude<BatchAcceptRouteStatus, 'applied'> } => result.status !== 'applied')
    .map((result) => ({ proposalId: result.proposalId, field: result.field, reason: EXCLUSION_REASON_BY_STATUS[result.status], message: result.message }));
  const auditId = results.length > 0 ? await recordBatchAcceptAudit(pool, {
    performedBy: input.actor, criteria: input.criteria, requestedCount: input.requestedCount,
    claims: applyResult.claims, excluded,
  }) : null;
  await Promise.all(results.map(async (result) => {
    if (result.status !== 'applied') return;
    const campId = campIdByProposal.get(result.proposalId);
    if (!campId) return;
    try {
      result.receipt = (await loadCampTrustDisplays(campId, [result.field])).fields[result.field];
    } catch (error) {
      console.error('batch-accept receipt projection failed after apply/audit:', error);
      result.receipt = { evidenceState: 'unverified', trustOrigin: 'none', label: 'Unverified', accessibleName: 'Unverified; receipt projection unavailable' };
    }
  }));
  return { auditId, results };
}
