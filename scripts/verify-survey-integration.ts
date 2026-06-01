import assert from 'node:assert/strict';
import { buildTrustReport, validateTrustInput } from '@kontourai/surface';

import {
  buildCampAttestationTrustInput,
  buildCampReviewTrustInput,
} from '../lib/admin/trust-projection';
import { CAMPFIT_CLAIM_TYPES, CAMPFIT_DECISION_EFFECTS } from '../lib/trust-vocabulary';

const reviewedAt = '2026-06-01T12:00:00.000Z';

const reviewTrustInput = buildCampReviewTrustInput({
  proposalId: 'proposal-1',
  campId: 'camp-1',
  sourceUrl: 'https://example.test/camps/summer',
  proposalCreatedAt: '2026-06-01T11:45:00.000Z',
  extractionModel: 'claude-sonnet-fixture',
  reviewer: 'operator@example.test',
  reviewedAt,
  reviewerNotes: 'Description accepted, phone rejected until source is clearer.',
  approvedFields: ['description'],
  proposedChanges: {
    description: {
      old: '',
      new: 'Outdoor day camp for ages 7-12.',
      confidence: 0.94,
      excerpt: 'Outdoor day camp for ages 7-12',
      sourceUrl: 'https://example.test/camps/summer',
      mode: 'populate',
    },
    contactPhone: {
      old: null,
      new: '303-555-0100',
      confidence: 0.64,
      excerpt: 'Call 303-555-0100',
      sourceUrl: 'https://example.test/camps/summer/contact',
      mode: 'populate',
    },
  },
});

const reviewReport = buildTrustReport(validateTrustInput(reviewTrustInput));
assert.equal(reviewReport.summary.byStatus.verified, 1);
assert.equal(reviewReport.summary.byStatus.rejected, 1);
assert.equal(reviewReport.evidence.length, 2);
assert.ok(reviewReport.claims.every((claim) => claim.metadata?.survey));
const rejectedCandidate = reviewReport.claims.find((claim) => claim.status === 'rejected');
assert.equal(rejectedCandidate?.claimType, CAMPFIT_CLAIM_TYPES.scalarFieldCandidate);
assert.equal(
  (rejectedCandidate?.metadata as { decisionEffect?: string } | undefined)?.decisionEffect,
  CAMPFIT_DECISION_EFFECTS.keptCurrentValue,
);

const attestationTrustInput = buildCampAttestationTrustInput({
  campId: 'camp-1',
  fields: ['pricing'],
  actor: 'operator@example.test',
  attestedAt: reviewedAt,
  notes: 'Pricing was reviewed and intentionally left blank.',
  values: {
    pricing: [],
  },
});

const attestationReport = buildTrustReport(validateTrustInput(attestationTrustInput));
assert.equal(attestationReport.summary.byStatus.assumed, 1);
assert.equal(attestationReport.events[0]?.method, 'survey-assumption');
assert.equal(attestationReport.claims[0]?.confidenceBasis?.reviewerAuthority, 'operator');

console.log('survey integration verification passed');
