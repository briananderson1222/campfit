import assert from 'node:assert/strict';
import { buildTrustReport, validateTrustInput } from '@kontourai/surface';

import {
  buildCampAttestationTrustInput,
  buildCampReviewTrustInput,
} from '../lib/admin/trust-projection';
import { CAMPFIT_CLAIM_TYPES, CAMPFIT_DECISION_EFFECTS } from '../lib/trust-vocabulary';

const reviewedAt = '2026-06-01T12:00:00.000Z';

function surveyMetadata(claim: { metadata?: Record<string, unknown> } | undefined): Record<string, unknown> {
  const survey = claim?.metadata?.survey;
  assert.equal(survey && typeof survey === 'object' && !Array.isArray(survey), true);
  return survey as Record<string, unknown>;
}

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
assert.equal(reviewReport.summary.totalClaims, 4);
assert.equal(reviewReport.summary.byStatus.verified, 2);
assert.equal(reviewReport.summary.byStatus.rejected, 1);
assert.equal(reviewReport.summary.byStatus.superseded, 1);
assert.equal(reviewReport.evidence.length, 4);
assert.ok(reviewReport.claims.every((claim) => claim.metadata?.survey));
const acceptedProposal = reviewReport.claims.find((claim) =>
  claim.fieldOrBehavior === 'description'
  && claim.status === 'verified'
  && claim.metadata?.candidateRole === 'proposed-value'
);
assert.equal(acceptedProposal?.id, 'camp.camp-1.field.description');
assert.equal(acceptedProposal?.value, 'Outdoor day camp for ages 7-12.');
assert.equal(acceptedProposal?.claimType, CAMPFIT_CLAIM_TYPES.scalarField);
assert.equal(
  (acceptedProposal?.metadata as { decisionEffect?: string } | undefined)?.decisionEffect,
  CAMPFIT_DECISION_EFFECTS.acceptedCandidateValue,
);
const acceptedSurvey = surveyMetadata(acceptedProposal);
assert.equal(acceptedSurvey.candidateSetId, 'camp.camp-1.field.description.proposal.proposal-1.candidates');
assert.equal(acceptedSurvey.candidateId, 'camp.camp-1.field.description.proposal.proposal-1.candidates.proposed.candidate');
assert.equal(acceptedSurvey.reviewOutcomeId, 'camp.camp-1.field.description.proposal.proposal-1.candidates.review');
assert.ok(reviewReport.events.some((event) =>
  event.claimId === acceptedProposal?.id
  && event.status === 'verified'
  && event.method === 'survey-review'
  && event.verifiedAt === reviewedAt
));
const supersededCurrent = reviewReport.claims.find((claim) =>
  claim.fieldOrBehavior === 'description'
  && claim.status === 'superseded'
  && claim.metadata?.candidateRole === 'current-value'
);
assert.equal(supersededCurrent?.value, '');
assert.equal(supersededCurrent?.id, 'camp.camp-1.field.description.proposal.proposal-1.current.claim');
assert.equal(supersededCurrent?.claimType, CAMPFIT_CLAIM_TYPES.scalarFieldCandidate);
const supersededSurvey = surveyMetadata(supersededCurrent);
assert.equal(supersededSurvey.candidateSetId, acceptedSurvey.candidateSetId);
assert.equal(supersededSurvey.candidateId, 'camp.camp-1.field.description.proposal.proposal-1.candidates.current.candidate');
assert.equal(supersededSurvey.reviewOutcomeId, undefined);

const retainedCurrent = reviewReport.claims.find((claim) =>
  claim.fieldOrBehavior === 'contactPhone'
  && claim.status === 'verified'
  && claim.metadata?.candidateRole === 'current-value'
);
assert.equal(retainedCurrent?.id, 'camp.camp-1.field.contactPhone');
assert.equal(retainedCurrent?.value, null);
assert.equal(retainedCurrent?.claimType, CAMPFIT_CLAIM_TYPES.scalarField);
assert.equal(
  (retainedCurrent?.metadata as { decisionEffect?: string } | undefined)?.decisionEffect,
  CAMPFIT_DECISION_EFFECTS.keptCurrentValue,
);
const retainedSurvey = surveyMetadata(retainedCurrent);
assert.equal(retainedSurvey.candidateSetId, 'camp.camp-1.field.contactPhone.proposal.proposal-1.candidates');
assert.equal(retainedSurvey.candidateId, 'camp.camp-1.field.contactPhone.proposal.proposal-1.candidates.current.candidate');
assert.equal(retainedSurvey.reviewOutcomeId, 'camp.camp-1.field.contactPhone.proposal.proposal-1.candidates.review');
const rejectedProposal = reviewReport.claims.find((claim) =>
  claim.fieldOrBehavior === 'contactPhone'
  && claim.status === 'rejected'
  && claim.metadata?.candidateRole === 'proposed-value'
);
assert.equal(rejectedProposal?.claimType, CAMPFIT_CLAIM_TYPES.scalarFieldCandidate);
assert.equal(rejectedProposal?.value, '303-555-0100');
assert.equal(
  (rejectedProposal?.metadata as { decisionEffect?: string } | undefined)?.decisionEffect,
  CAMPFIT_DECISION_EFFECTS.keptCurrentValue,
);
assert.equal(rejectedProposal?.id, 'camp.camp-1.field.contactPhone.proposal.proposal-1.proposed.claim');
const rejectedSurvey = surveyMetadata(rejectedProposal);
assert.equal(rejectedSurvey.candidateSetId, retainedSurvey.candidateSetId);
assert.equal(rejectedSurvey.candidateId, 'camp.camp-1.field.contactPhone.proposal.proposal-1.candidates.proposed.candidate');
assert.equal(rejectedSurvey.reviewOutcomeId, undefined);
assert.ok(reviewReport.events.some((event) =>
  event.claimId === rejectedProposal?.id
  && event.status === 'rejected'
  && event.method === 'survey-rejection'
));
assert.equal(
  reviewReport.evidence.filter((evidence) => evidence.metadata?.decisionEffect === CAMPFIT_DECISION_EFFECTS.keptCurrentValue).length,
  2,
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
