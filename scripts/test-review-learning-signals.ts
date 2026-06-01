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

console.log('review learning signal verification passed');
