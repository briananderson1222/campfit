import assert from 'node:assert/strict';
import type { ReviewSessionEvent } from '@kontourai/survey';
import { buildReviewSessionEvents } from '@kontourai/survey/review-workbench';

import {
  deriveCampApplyFromSurveySession,
  SurveyReviewApplyError,
} from '../lib/admin/survey-review-apply';
import { buildCampSurveyReviewQueueSession } from '../lib/admin/survey-review-items';
import type { CampChangeProposal } from '../lib/admin/types';

const proposal: CampChangeProposal = {
  id: 'proposal-apply-1',
  campId: 'camp-apply-1',
  crawlRunId: 'crawl-apply-1',
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
    websiteUrl: {
      old: 'https://old.example.test',
      new: 'https://new.example.test',
      confidence: 0.78,
      excerpt: 'Visit https://new.example.test',
      sourceUrl: 'https://example.test/camps/summer/contact',
      mode: 'update',
    },
  },
  overallConfidence: 0.88,
  extractionModel: 'claude-sonnet-fixture',
  reviewerNotes: null,
  feedbackTags: ['needs-authority-review'],
  priority: 0,
  appliedFields: [],
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

const session = buildCampSurveyReviewQueueSession(proposal, {
  actorId: 'operator@example.test',
  reviewedAt: '2026-06-01T12:00:00.000Z',
});
const [description, contactPhone, websiteUrl] = session.items;
assert.ok(description);
assert.ok(contactPhone);
assert.ok(websiteUrl);

const completeEvents = buildReviewSessionEvents({
  ...session,
  notesByItemName: {
    [description.metadata.name]: 'Matches source excerpt.',
  },
  decisionsByItemName: {
    [description.metadata.name]: 'accept-proposed',
    [contactPhone.metadata.name]: 'keep-current',
    [websiteUrl.metadata.name]: 'reject-proposed',
  },
});

const completeApply = deriveCampApplyFromSurveySession({
  proposal,
  session,
  events: completeEvents,
});
assert.deepEqual(completeApply.approvedFields, ['description']);
assert.deepEqual(completeApply.rejectedFields, ['contactPhone', 'websiteUrl']);
assert.equal(completeApply.results.length, 3);
assert.equal(completeApply.decisions.length, 3);
assert.match(completeApply.reviewerNotes ?? '', /Matches source excerpt/);
assert.equal(completeApply.results[0]?.selectedCandidateRole, 'proposed');
assert.equal(completeApply.results[1]?.selectedCandidateRole, 'current');
assert.equal(completeApply.results[2]?.decision, 'reject-proposed');

assert.throws(
  () => deriveCampApplyFromSurveySession({
    proposal,
    session,
    events: buildReviewSessionEvents({
      ...session,
      decisionsByItemName: {
        [description.metadata.name]: 'accept-proposed',
      },
    }),
  }),
  SurveyReviewApplyError,
);

const partialApply = deriveCampApplyFromSurveySession({
  proposal,
  session,
  events: buildReviewSessionEvents({
    ...session,
    decisionsByItemName: {
      [description.metadata.name]: 'accept-proposed',
    },
  }),
  mode: 'partial',
});
assert.deepEqual(partialApply.approvedFields, ['description']);
assert.deepEqual(partialApply.rejectedFields, []);

const unknownItemEvent: ReviewSessionEvent = {
  ...completeEvents[0]!,
  metadata: {
    ...completeEvents[0]!.metadata,
    name: 'unknown-item-event',
  },
  spec: {
    ...completeEvents[0]!.spec,
    reviewItemName: 'camp-proposal-other-field',
  },
};
assert.throws(
  () => deriveCampApplyFromSurveySession({
    proposal,
    session,
    events: [unknownItemEvent],
  }),
  SurveyReviewApplyError,
);

assert.throws(
  () => deriveCampApplyFromSurveySession({
    proposal: {
      ...proposal,
      proposedChanges: {
        description: proposal.proposedChanges.description,
      },
    },
    session,
    events: completeEvents,
  }),
  SurveyReviewApplyError,
);

const partiallyAppliedProposal: CampChangeProposal = {
  ...proposal,
  id: 'proposal-apply-partial',
  appliedFields: ['description'],
};
const includeAppliedSession = buildCampSurveyReviewQueueSession(partiallyAppliedProposal, {
  actorId: 'operator@example.test',
  reviewedAt: '2026-06-01T12:30:00.000Z',
  includeAppliedFields: true,
});
assert.ok(
  includeAppliedSession.items.some((item) => item.spec.target === 'description'),
  'includeAppliedFields should preserve previously applied items for Survey replay',
);
const includeAppliedApply = deriveCampApplyFromSurveySession({
  proposal: partiallyAppliedProposal,
  session: includeAppliedSession,
  events: buildReviewSessionEvents({
    ...includeAppliedSession,
    decisionsByItemName: Object.fromEntries(
      includeAppliedSession.items.map((item) => [item.metadata.name, item.spec.target === 'websiteUrl' ? 'reject-proposed' : 'keep-current']),
    ),
  }),
});
assert.deepEqual(includeAppliedApply.approvedFields, []);
assert.deepEqual(includeAppliedApply.rejectedFields.sort(), ['contactPhone', 'websiteUrl'].sort());

assert.throws(
  () => deriveCampApplyFromSurveySession({
    proposal: partiallyAppliedProposal,
    session: includeAppliedSession,
    events: buildReviewSessionEvents({
      ...includeAppliedSession,
      decisionsByItemName: {
        [includeAppliedSession.items.find((item) => item.spec.target === 'description')!.metadata.name]: 'keep-current',
      },
    }),
    mode: 'partial',
  }),
  SurveyReviewApplyError,
);

console.log('survey apply path verification passed');
