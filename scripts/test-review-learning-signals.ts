import assert from 'node:assert/strict';

import { buildRejectedProposalLearningDimensions } from '../lib/admin/metrics-repository';
import { CAMPFIT_DECISION_EFFECTS } from '../lib/trust-vocabulary';

const dimensions = buildRejectedProposalLearningDimensions({
  proposalId: 'proposal-1',
  field: 'contactPhone',
  diff: {
    old: '303-555-0000',
    new: '303-555-0100',
    confidence: 0.64,
    excerpt: 'Call 303-555-0100',
    sourceUrl: 'https://example.test/camps/summer/contact',
    mode: 'populate',
  },
  reviewerNotes: 'Phone number belongs to a different location.',
  feedbackTags: ['wrong-location', 'bad-excerpt'],
  extractionModel: 'campfit-crawl-fixture',
  overallConfidence: 0.72,
});

assert.equal(dimensions.proposalId, 'proposal-1');
assert.equal(dimensions.field, 'contactPhone');
assert.equal(dimensions.decisionEffect, CAMPFIT_DECISION_EFFECTS.keptCurrentValue);
assert.equal(dimensions.currentValue, '303-555-0000');
assert.equal(dimensions.proposedValue, '303-555-0100');
assert.equal(dimensions.confidence, '0.64');
assert.equal(dimensions.feedbackTags, 'wrong-location,bad-excerpt');
assert.equal(dimensions.surveyLearningProjectionKind, undefined);
assert.equal(dimensions.surveyLearningProjectionSignal, undefined);

const authorityReviewDimensions = buildRejectedProposalLearningDimensions({
  proposalId: 'proposal-2',
  field: 'ageRange',
  diff: {
    old: '7-12',
    new: '8-12',
    confidence: 0.58,
    excerpt: 'Ages vary by session; confirm with published policy.',
    sourceUrl: 'https://example.test/camps/summer/age',
    mode: 'update',
  },
  reviewerNotes: 'Needs policy authority review before changing eligibility.',
  feedbackTags: ['needs-authority-review'],
  extractionModel: 'campfit-crawl-fixture',
});

assert.equal(authorityReviewDimensions.surveyLearningProjectionKind, 'learning.comfort-zone');
assert.equal(authorityReviewDimensions.surveyLearningProjectionSignal, 'comfort-zone.outside');
assert.equal(authorityReviewDimensions.surveyLearningProjectionSource, 'campfit.review-learning');
assert.equal(
  authorityReviewDimensions.surveyLearningProjectionReviewOutcomeId,
  'proposal.proposal-2.field.ageRange.rejected.learning.review',
);

for (const feedbackTag of ['outside-comfort-zone', 'needs-domain-review']) {
  const taggedDimensions = buildRejectedProposalLearningDimensions({
    proposalId: `proposal-${feedbackTag}`,
    field: 'ageRange',
    diff: {
      old: '7-12',
      new: '8-12',
      confidence: 0.58,
      excerpt: 'Ages vary by session; confirm with published policy.',
      sourceUrl: 'https://example.test/camps/summer/age',
      mode: 'update',
    },
    feedbackTags: [feedbackTag],
  });

  assert.equal(taggedDimensions.surveyLearningProjectionSignal, 'comfort-zone.outside');
}

console.log('review learning signal verification passed');
