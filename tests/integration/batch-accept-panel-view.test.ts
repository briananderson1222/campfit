/**
 * tests/integration/batch-accept-panel-view.test.ts — pure unit coverage for
 * `app/admin/review/batch-accept-panel-view.ts` (campfit#51, Wave 3 Task
 * 3.2, R1/R2/AC1/AC2), mirroring `candidates-panel-view.test.ts`'s exact
 * style. No DB.
 */
import { describe, expect, it } from 'vitest';

import {
  batchAcceptResultCopy,
  classifyBatchAcceptResponse,
  corroboratedFieldChips,
  lanesFromRankedQueue,
} from '@/app/admin/review/batch-accept-panel-view';
import type { RankedProposal } from '@/lib/admin/review-repository';

function proposal(overrides: Partial<RankedProposal> = {}): RankedProposal {
  return {
    id: 'proposal-1',
    campId: 'camp-1',
    crawlRunId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    reviewedAt: null,
    reviewedBy: null,
    status: 'PENDING',
    sourceUrl: 'https://example.test/camp',
    rawExtraction: {},
    proposedChanges: {
      city: { old: '', new: 'Austin', confidence: 0.9 },
      name: { old: '', new: 'New Name', confidence: 0.9 },
    },
    overallConfidence: 0.9,
    extractionModel: 'test-model',
    reviewerNotes: null,
    feedbackTags: null,
    priority: 0,
    appliedFields: [],
    campName: 'Test Camp',
    communitySlug: 'denver',
    fieldCorroboration: {
      city: { field: 'city', value: 'Austin', exact: true, corroboratingProposalIds: ['other'], corroboratingSourceUrls: ['https://a.test'], sameSourceUrl: false },
      name: { field: 'name', value: 'New Name', exact: false, corroboratingProposalIds: [], corroboratingSourceUrls: [], sameSourceUrl: false },
    },
    batchEligibleFieldCount: 1,
    ...overrides,
  };
}

describe('corroboratedFieldChips', () => {
  it('marks only exact-corroborated fields selectable, in the same priority order', () => {
    const chips = corroboratedFieldChips(proposal());
    expect(chips.map((c) => c.field)).toEqual(['name', 'city']); // name has priority 0, city priority 4
    expect(chips.find((c) => c.field === 'city')?.selectable).toBe(true);
    expect(chips.find((c) => c.field === 'name')?.selectable).toBe(false);
  });

  it('reports corroboratingCount from the derivation, 0 when uncorroborated or missing', () => {
    const chips = corroboratedFieldChips(proposal());
    expect(chips.find((c) => c.field === 'city')?.corroboratingCount).toBe(1);
    expect(chips.find((c) => c.field === 'name')?.corroboratingCount).toBe(0);
  });

  it('handles a field with no fieldCorroboration entry at all (defensive, not selectable)', () => {
    const p = proposal({ proposedChanges: { description: { old: '', new: 'x', confidence: 0.5 } }, fieldCorroboration: {} });
    const chips = corroboratedFieldChips(p);
    expect(chips).toEqual([{ field: 'description', selectable: false, corroboratingCount: 0 }]);
  });
});

describe('lanesFromRankedQueue', () => {
  it('computes per-lane total/selectable field counts without re-deriving corroboration', () => {
    const batchReadyProposal = proposal({ id: 'p1' });
    const needsReviewProposal = proposal({
      id: 'p2',
      proposedChanges: { description: { old: '', new: 'x', confidence: 0.2 } },
      fieldCorroboration: { description: { field: 'description', value: 'x', exact: false, corroboratingProposalIds: [], corroboratingSourceUrls: [], sameSourceUrl: false } },
      batchEligibleFieldCount: 0,
    });

    const lanes = lanesFromRankedQueue([batchReadyProposal], [needsReviewProposal]);

    expect(lanes.batchReady.proposals).toEqual([batchReadyProposal]);
    expect(lanes.batchReady.totalFields).toBe(2);
    expect(lanes.batchReady.selectableFields).toBe(1);

    expect(lanes.needsReview.proposals).toEqual([needsReviewProposal]);
    expect(lanes.needsReview.totalFields).toBe(1);
    expect(lanes.needsReview.selectableFields).toBe(0);
  });

  it('handles empty lanes', () => {
    const lanes = lanesFromRankedQueue([], []);
    expect(lanes.batchReady).toEqual({ proposals: [], totalFields: 0, selectableFields: 0 });
    expect(lanes.needsReview).toEqual({ proposals: [], totalFields: 0, selectableFields: 0 });
  });
});

describe('classifyBatchAcceptResponse', () => {
  it('classifies a network error', () => {
    expect(classifyBatchAcceptResponse({ kind: 'network-error' })).toEqual({
      status: 'error',
      message: 'Failed to submit batch accept',
    });
  });

  it('classifies an HTTP error with a body-provided message', () => {
    expect(classifyBatchAcceptResponse({ kind: 'http-error', status: 403, body: { error: 'Forbidden' } })).toEqual({
      status: 'error',
      message: 'Forbidden',
    });
  });

  it('classifies an HTTP error with no body message using a generic fallback', () => {
    expect(classifyBatchAcceptResponse({ kind: 'http-error', status: 500, body: null })).toEqual({
      status: 'error',
      message: 'Failed to submit batch accept (status 500)',
    });
  });

  it('classifies a malformed 200 body (no results array) as an error', () => {
    expect(classifyBatchAcceptResponse({ kind: 'ok', body: { auditId: null } })).toEqual({
      status: 'error',
      message: 'Failed to submit batch accept (unexpected response shape)',
    });
  });

  it('classifies a well-formed 200 body, including a null auditId', () => {
    const results = [{ proposalId: 'p1', field: 'city', status: 'applied' as const }];
    expect(classifyBatchAcceptResponse({ kind: 'ok', body: { auditId: null, results } })).toEqual({
      status: 'ready',
      auditId: null,
      results,
    });
    expect(classifyBatchAcceptResponse({ kind: 'ok', body: { auditId: 'audit-1', results } })).toEqual({
      status: 'ready',
      auditId: 'audit-1',
      results,
    });
  });
});

describe('batchAcceptResultCopy', () => {
  it('renders default copy per status when no message is provided', () => {
    expect(batchAcceptResultCopy({ proposalId: 'p', field: 'f', status: 'applied' })).toBe('Applied.');
    expect(batchAcceptResultCopy({ proposalId: 'p', field: 'f', status: 'excluded_not_pending' })).toMatch(/no longer pending/i);
    expect(batchAcceptResultCopy({ proposalId: 'p', field: 'f', status: 'excluded_not_corroborated' })).toMatch(/not corroborated/i);
    expect(batchAcceptResultCopy({ proposalId: 'p', field: 'f', status: 'excluded_scope' })).toMatch(/community scope/i);
    expect(batchAcceptResultCopy({ proposalId: 'p', field: 'f', status: 'error' })).toMatch(/failed/i);
  });

  it('prefers a server-supplied message over the default copy', () => {
    expect(batchAcceptResultCopy({ proposalId: 'p', field: 'f', status: 'error', message: 'Custom failure' })).toBe('Custom failure');
  });
});
