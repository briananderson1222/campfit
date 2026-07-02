import assert from 'node:assert/strict';

import { buildSurveyLearningProjections } from '@kontourai/survey';

import { buildRejectedProposalLearningDimensions } from '../lib/admin/metrics-repository';
import { buildCampReviewSurveyInput } from '../lib/admin/trust-projection';
import { campfitVocabulary } from '../lib/trust-vocabulary';

const ordinaryRejectionReason = 'Phone number belongs to a different location.';
const ordinaryProposalId = 'proposal-1';
const ordinaryField = 'contactPhone';
const ordinaryDiff = {
  old: '303-555-0000',
  new: '303-555-0100',
  confidence: 0.64,
  excerpt: 'Call 303-555-0100',
  sourceUrl: 'https://example.test/camps/summer/contact',
  mode: 'populate' as const,
};

const dimensions = buildRejectedProposalLearningDimensions({
  proposalId: ordinaryProposalId,
  field: ordinaryField,
  diff: ordinaryDiff,
  reviewerNotes: ordinaryRejectionReason,
  feedbackTags: ['wrong-location', 'bad-excerpt'],
  extractionModel: 'campfit-crawl-fixture',
  overallConfidence: 0.72,
});

assert.equal(dimensions.proposalId, ordinaryProposalId);
assert.equal(dimensions.field, ordinaryField);
assert.equal(dimensions.decisionEffect, campfitVocabulary.decisionEffects.keptCurrentValue);
assert.equal(dimensions.currentValue, ordinaryDiff.old);
assert.equal(dimensions.proposedValue, ordinaryDiff.new);
assert.equal(dimensions.confidence, '0.64');
assert.equal(dimensions.feedbackTags, 'wrong-location,bad-excerpt');
assert.equal(dimensions.surveyLearningProjectionKind, undefined);
assert.equal(dimensions.surveyLearningProjectionSignal, undefined);
assert.equal(dimensions.surveyLearningProjectionSource, undefined);

const ordinarySurveyInput = buildCampReviewSurveyInput({
  proposalId: ordinaryProposalId,
  campId: 'camp-1',
  sourceUrl: 'https://example.test/camps/summer',
  proposalCreatedAt: '2026-06-01T11:45:00.000Z',
  extractionModel: 'campfit-crawl-fixture',
  reviewer: 'operator@example.test',
  reviewedAt: '2026-06-01T12:00:00.000Z',
  reviewerNotes: ordinaryRejectionReason,
  feedbackTags: ['wrong-location', 'bad-excerpt'],
  approvedFields: [],
  proposedChanges: {
    [ordinaryField]: ordinaryDiff,
  },
});

const ordinaryLearning = buildSurveyLearningProjections(ordinarySurveyInput);
const ordinaryRejectedCandidate = ordinaryLearning.find((projection) =>
  projection.kind === 'learning.rejected-candidate'
);
const ordinaryRejectedCandidateMetadata = ordinaryRejectedCandidate?.metadata?.rejectedCandidate as
  | { rejectionReason?: string; candidateRejectionReason?: string }
  | undefined;
assert.equal(ordinaryRejectedCandidate?.signal, 'rejected-candidate.reason');
assert.equal(ordinaryRejectedCandidate?.source, 'campfit.admin.review');
assert.equal(ordinaryRejectedCandidate?.target, 'camp.camp-1.field.contactPhone');
assert.equal(
  ordinaryRejectedCandidateMetadata?.rejectionReason,
  ordinaryRejectionReason,
);
assert.equal(
  ordinaryRejectedCandidateMetadata?.candidateRejectionReason,
  ordinaryRejectionReason,
);
assert.equal(
  ordinaryLearning.some((projection) => projection.kind === 'learning.comfort-zone'),
  false,
);

const authorityReviewSurveyInput = buildCampReviewSurveyInput({
  proposalId: 'proposal-2',
  campId: 'camp-1',
  sourceUrl: 'https://example.test/camps/summer',
  extractionModel: 'campfit-crawl-fixture',
  reviewer: 'operator@example.test',
  reviewedAt: '2026-06-01T12:30:00.000Z',
  reviewerNotes: 'Needs policy authority review before changing eligibility.',
  feedbackTags: ['needs-authority-review'],
  approvedFields: [],
  proposedChanges: {
    ageRange: {
      old: '7-12',
      new: '8-12',
      confidence: 0.58,
      excerpt: 'Ages vary by session; confirm with published policy.',
      sourceUrl: 'https://example.test/camps/summer/age',
      mode: 'update',
    },
  },
});

const authorityReviewLearning = buildSurveyLearningProjections(authorityReviewSurveyInput);
assert.equal(
  authorityReviewLearning.some((projection) =>
    projection.kind === 'learning.comfort-zone'
    && projection.signal === 'comfort-zone.outside'
  ),
  true,
);

const domainReviewSurveyInput = buildCampReviewSurveyInput({
  proposalId: 'proposal-3',
  campId: 'camp-1',
  sourceUrl: 'https://example.test/camps/summer',
  reviewer: 'operator@example.test',
  reviewedAt: '2026-06-01T12:45:00.000Z',
  feedbackTags: ['needs-domain-review'],
  approvedFields: [],
  proposedChanges: {
    ageRange: {
      old: '7-12',
      new: '8-12',
      confidence: 0.58,
      excerpt: 'Ages vary by session; confirm with published policy.',
      sourceUrl: 'https://example.test/camps/summer/age',
      mode: 'update',
    },
  },
});

assert.equal(
  buildSurveyLearningProjections(domainReviewSurveyInput).some((projection) =>
    projection.kind === 'learning.comfort-zone'
    && projection.signal === 'comfort-zone.outside'
  ),
  true,
);

const outsideComfortZoneSurveyInput = buildCampReviewSurveyInput({
  proposalId: 'proposal-4',
  campId: 'camp-1',
  sourceUrl: 'https://example.test/camps/summer',
  reviewer: 'operator@example.test',
  reviewedAt: '2026-06-01T13:00:00.000Z',
  feedbackTags: ['outside-comfort-zone'],
  approvedFields: [],
  proposedChanges: {
    ageRange: {
      old: '7-12',
      new: '8-12',
      confidence: 0.58,
      excerpt: 'Ages vary by session; confirm with published policy.',
      sourceUrl: 'https://example.test/camps/summer/age',
      mode: 'update',
    },
  },
});

assert.equal(
  buildSurveyLearningProjections(outsideComfortZoneSurveyInput).some((projection) =>
    projection.kind === 'learning.comfort-zone'
  ),
  false,
);

const authorityReviewDimensions = buildRejectedProposalLearningDimensions({
  proposalId: 'proposal-2',
  field: 'contactPhone',
  diff: {
    old: '303-555-0000',
    new: '303-555-0100',
    confidence: 0.64,
    excerpt: 'Call 303-555-0100',
    sourceUrl: 'https://example.test/camps/summer/contact',
    mode: 'populate',
  },
  reviewerNotes: 'Needs policy authority review before changing eligibility.',
  feedbackTags: ['needs-authority-review'],
  extractionModel: 'campfit-crawl-fixture',
});
assert.equal(authorityReviewDimensions.proposalId, 'proposal-2');
assert.equal(authorityReviewDimensions.feedbackTags, 'needs-authority-review');
assert.equal(authorityReviewDimensions.surveyLearningProjectionKind, undefined);
assert.equal(authorityReviewDimensions.surveyLearningProjectionSignal, undefined);

console.log('review learning signal verification passed');
