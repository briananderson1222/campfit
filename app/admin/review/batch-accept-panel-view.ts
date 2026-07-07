/**
 * app/admin/review/batch-accept-panel-view.ts — pure, framework-free
 * helpers for `batch-accept-panel.tsx` (campfit#51, Wave 3 Task 3.2).
 *
 * Split out from the `'use client'` panel specifically so this logic has a
 * real unit-test surface — this repo has no jsdom/testing-library harness
 * for rendering `'use client'` components with hooks (verified: zero
 * `.test.tsx` files, no `testing-library` dependency; see campfit#96, the
 * standing accepted gap `candidates-panel-view.ts`'s own header doc records
 * for the same reason). Every export here is a plain function over plain
 * data — no React import, no hooks — exercised directly by
 * `tests/integration/batch-accept-panel-view.test.ts`, following
 * `candidates-panel-view.ts`'s exact split (campfit#93).
 */
import type { RankedProposal } from '@/lib/admin/review-repository';

/** Same field-display-priority ordering `app/admin/review/page.tsx`'s own
 * `prioritizedFields` uses for the existing single-list proposal cards —
 * duplicated here (not imported) because `page.tsx` is a server component
 * and this map only ever needs the SCALAR fields a batch-ready lane's chips
 * can show (relation fields never appear in `fieldCorroboration` — see
 * `claim-corroboration.ts`'s scope note), a strict subset of `page.tsx`'s
 * own list. Both lists are the same visual-priority CONCEPT, not a forked
 * data model. */
const FIELD_PRIORITY: Record<string, number> = {
  name: 0,
  registrationStatus: 1,
  description: 2,
  websiteUrl: 3,
  city: 4,
  neighborhood: 5,
  address: 6,
};

function prioritizedFields(fields: string[]): string[] {
  return [...fields].sort((fieldA, fieldB) => {
    const priorityA = FIELD_PRIORITY[fieldA] ?? 100;
    const priorityB = FIELD_PRIORITY[fieldB] ?? 100;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return fieldA.localeCompare(fieldB);
  });
}

export interface FieldChip {
  field: string;
  /** True iff `deriveFieldCorroboration` resolved `exact: true` for this
   * field on this proposal — the ONLY chips the panel lets a reviewer
   * check. This is defense-in-depth ONLY: the real gates are
   * `applyBatchAcceptedClaims`'s server-side re-derivation and the route's
   * own community-scope re-check (both re-verify independently of this
   * flag, never trust it — see the plan's AC2 dual-layer requirement). */
  selectable: boolean;
  corroboratingCount: number;
}

/** Which of a `RankedProposal`'s field chips are checkbox-selectable
 * (exact-corroborated) vs. plain (not batch-eligible, still requires the
 * existing single-proposal `applyProposalReview` flow). */
export function corroboratedFieldChips(
  proposal: Pick<RankedProposal, 'proposedChanges' | 'fieldCorroboration'>,
): FieldChip[] {
  return prioritizedFields(Object.keys(proposal.proposedChanges)).map((field) => {
    const corroboration = proposal.fieldCorroboration[field];
    return {
      field,
      selectable: corroboration?.exact === true,
      corroboratingCount: corroboration?.corroboratingProposalIds.length ?? 0,
    };
  });
}

export interface RankedQueueLane {
  proposals: RankedProposal[];
  /** Total scalar Candidate Claim fields across every proposal in this lane. */
  totalFields: number;
  /** Of `totalFields`, how many are exact-corroborated (checkbox-selectable in the batchReady lane). */
  selectableFields: number;
}

/** View-model shaping for the two-lane queue: pairs each lane's raw
 * `RankedProposal[]` (from `getRankedReviewQueue`) with the field-chip
 * counts the panel's header/summary copy needs, without re-deriving
 * corroboration itself (reads `fieldCorroboration`, already computed
 * server-side). */
export function lanesFromRankedQueue(
  batchReady: RankedProposal[],
  needsReview: RankedProposal[],
): { batchReady: RankedQueueLane; needsReview: RankedQueueLane } {
  function laneFor(proposals: RankedProposal[]): RankedQueueLane {
    let totalFields = 0;
    let selectableFields = 0;
    for (const proposal of proposals) {
      const chips = corroboratedFieldChips(proposal);
      totalFields += chips.length;
      selectableFields += chips.filter((chip) => chip.selectable).length;
    }
    return { proposals, totalFields, selectableFields };
  }

  return { batchReady: laneFor(batchReady), needsReview: laneFor(needsReview) };
}

function extractErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.length > 0) return err;
  }
  return null;
}

/** The batch-accept route's declared per-selection result shape
 * (`app/api/admin/review/batch-accept/route.ts`'s `BatchAcceptRouteResult`). */
export interface BatchAcceptResultRow {
  proposalId: string;
  field: string;
  status: 'applied' | 'excluded_not_pending' | 'excluded_not_corroborated' | 'excluded_scope' | 'error';
  message?: string;
}

export type BatchAcceptFetchOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http-error'; status: number; body: unknown }
  | { kind: 'network-error' };

export type BatchAcceptSubmitResult =
  | { status: 'ready'; auditId: string | null; results: BatchAcceptResultRow[] }
  | { status: 'error'; message: string };

/** Classifies `POST /api/admin/review/batch-accept`'s response (the route's
 * declared contract: `{auditId: string | null, results: [...]}`). */
export function classifyBatchAcceptResponse(outcome: BatchAcceptFetchOutcome): BatchAcceptSubmitResult {
  switch (outcome.kind) {
    case 'network-error':
      return { status: 'error', message: 'Failed to submit batch accept' };
    case 'http-error':
      return {
        status: 'error',
        message: extractErrorMessage(outcome.body) ?? `Failed to submit batch accept (status ${outcome.status})`,
      };
    case 'ok': {
      const body = outcome.body as { results?: unknown; auditId?: unknown } | null;
      if (!body || !Array.isArray(body.results)) {
        return { status: 'error', message: 'Failed to submit batch accept (unexpected response shape)' };
      }
      return {
        status: 'ready',
        auditId: typeof body.auditId === 'string' ? body.auditId : null,
        results: body.results as BatchAcceptResultRow[],
      };
    }
  }
}

/** Per-result inline outcome copy — one line of human-readable feedback per
 * selected field, rendered inline under its chip after a batch-accept
 * submit. */
export function batchAcceptResultCopy(result: BatchAcceptResultRow): string {
  switch (result.status) {
    case 'applied':
      return 'Applied.';
    case 'excluded_not_pending':
      return result.message ?? 'This proposal is no longer pending.';
    case 'excluded_not_corroborated':
      return result.message ?? 'Not corroborated by another crawl — use the individual review flow.';
    case 'excluded_scope':
      return result.message ?? 'Outside your community scope.';
    case 'error':
      return result.message ?? 'Failed to apply this field.';
    default:
      return 'Unknown outcome.';
  }
}
