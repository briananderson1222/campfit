import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildReviewWorkbenchResultsFromSession } from '@kontourai/survey/review-workbench';

import { SurveyReviewWorkbench } from '../components/admin/survey-review-workbench';
import { buildCampSurveyReviewItems, buildCampSurveyReviewQueueSession } from '../lib/admin/survey-review-items';
import type { CampChangeProposal } from '../lib/admin/types';

const proposal: CampChangeProposal = {
  id: 'proposal-1',
  campId: 'camp-1',
  crawlRunId: 'crawl-1',
  createdAt: '2026-06-01T11:45:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  status: 'PENDING',
  sourceUrl: 'https://example.test/camps/summer',
  rawExtraction: {},
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
  overallConfidence: 0.88,
  extractionModel: 'claude-sonnet-fixture',
  reviewerNotes: null,
  feedbackTags: ['needs-authority-review'],
  priority: 0,
  appliedFields: ['contactPhone'],
  campName: 'Example Summer Camp',
  campSlug: 'example-summer-camp',
  communitySlug: 'denver',
  providerId: 'provider-1',
  lastVerifiedAt: null,
  campData: {},
  fieldTimeline: {},
  crawlStartedAt: '2026-06-01T11:40:00.000Z',
  crawlCompletedAt: '2026-06-01T11:44:00.000Z',
  crawlTrigger: 'MANUAL',
  crawlTriggeredBy: 'operator@example.test',
};

const items = buildCampSurveyReviewItems(proposal);
assert.equal(items.length, 1);
assert.equal(items[0]?.apiVersion, 'survey.kontourai.io/v1alpha1');
assert.equal(items[0]?.kind, 'ReviewItem');
assert.equal(items[0]?.metadata.name, 'camp-proposal-proposal-1-description');
assert.equal(items[0]?.metadata.producer?.displayName, 'Example Summer Camp');
assert.equal(items[0]?.spec.target, 'description');
assert.equal(items[0]?.spec.candidateSetStatus, 'needs-review');
assert.equal(items[0]?.spec.candidates.length, 2);
assert.equal(items[0]?.spec.candidates[0]?.role, 'current');
assert.equal(items[0]?.spec.candidates[1]?.role, 'proposed');
assert.equal(items[0]?.spec.candidates[1]?.value, 'Outdoor day camp for ages 7-12.');
assert.equal(items[0]?.spec.candidates[1]?.source.sourceRef, 'https://example.test/camps/summer');
assert.equal(items[0]?.spec.candidates[1]?.producer?.sourceAuthority && typeof items[0].spec.candidates[1].producer.sourceAuthority, 'object');
assert.deepEqual(items[0]?.spec.producerPolicy?.feedbackTags, ['needs-authority-review']);

const allItems = buildCampSurveyReviewItems(proposal, { includeAppliedFields: true });
assert.equal(allItems.length, 2);
assert.equal(allItems[1]?.spec.candidates[0]?.value, null);
assert.equal(allItems[1]?.spec.candidates[1]?.value, '303-555-0100');

const session = buildCampSurveyReviewQueueSession(proposal, {
  actorId: 'operator@example.test',
  reviewedAt: '2026-06-01T12:00:00.000Z',
});
assert.equal(session.items.length, 1);
assert.equal(session.activeItemName, 'camp-proposal-proposal-1-description');
assert.equal(session.actorId, 'operator@example.test');
assert.equal(session.reviewedAt, '2026-06-01T12:00:00.000Z');

const results = buildReviewWorkbenchResultsFromSession({
  ...session,
  decisionsByItemName: {
    [session.items[0]!.metadata.name]: 'accept-proposed',
  },
});
assert.equal(results.length, 1);
assert.equal(results[0]?.selectedCandidateRole, 'proposed');
assert.equal(results[0]?.selectedValue, 'Outdoor day camp for ages 7-12.');
assert.equal(results[0]?.reviewDecision.spec.status, 'verified');

const markup = renderToStaticMarkup(createElement(SurveyReviewWorkbench, { session }));
assert.match(markup, /Survey queue payload/);
assert.match(markup, /Outdoor day camp for ages 7-12/);
assert.match(markup, /publisher_owned_page/);
assert.match(markup, /Surface preview/);

console.log('survey review item verification passed');
