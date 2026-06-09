import assert from 'node:assert/strict';
import { buildReviewSessionEvents } from '@kontourai/survey/review-workbench';

import {
  SurveyReviewEventValidationError,
  validateSurveyReviewEventsForSession,
} from '../lib/admin/survey-review-events';
import {
  assertSurveyReviewSessionFreshForProposal,
  hashSurveyReviewSnapshot,
  type SurveyReviewSessionRecord,
  SurveyReviewSessionStaleError,
} from '../lib/admin/survey-review-sessions';
import { buildCampSurveyReviewQueueSession } from '../lib/admin/survey-review-items';
import type { CampChangeProposal } from '../lib/admin/types';

const proposal: CampChangeProposal = {
  id: 'proposal-session-1',
  campId: 'camp-session-1',
  crawlRunId: 'crawl-session-1',
  createdAt: '2026-06-01T11:45:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  status: 'PENDING',
  sourceUrl: 'https://example.test/camps/session',
  rawExtraction: {},
  proposedChanges: {
    description: {
      old: '',
      new: 'Outdoor day camp for ages 7-12.',
      confidence: 0.94,
      excerpt: 'Outdoor day camp for ages 7-12',
      sourceUrl: 'https://example.test/camps/session',
      mode: 'populate',
    },
    contactPhone: {
      old: null,
      new: '303-555-0100',
      confidence: 0.64,
      excerpt: 'Call 303-555-0100',
      sourceUrl: 'https://example.test/camps/session/contact',
      mode: 'populate',
    },
  },
  overallConfidence: 0.88,
  extractionModel: 'claude-sonnet-fixture',
  reviewerNotes: null,
  feedbackTags: null,
  priority: 0,
  appliedFields: [],
  campName: 'Example Session Camp',
  campSlug: 'example-session-camp',
  communitySlug: 'denver',
  providerId: 'provider-session-1',
  lastVerifiedAt: null,
  campData: {},
  fieldTimeline: {},
  crawlStartedAt: '2026-06-01T11:40:00.000Z',
  crawlCompletedAt: '2026-06-01T11:44:00.000Z',
  crawlTrigger: 'MANUAL',
  crawlTriggeredBy: 'operator@example.test',
};

const snapshot = buildCampSurveyReviewQueueSession(proposal, {
  actorId: 'operator@example.test',
  reviewedAt: '2026-06-01T12:00:00.000Z',
  includeAppliedFields: true,
});
const [description, contactPhone] = snapshot.items;
assert.ok(description);
assert.ok(contactPhone);

const events = buildReviewSessionEvents({
  ...snapshot,
  decisionsByItemName: {
    [description.metadata.name]: 'accept-proposed',
    [contactPhone.metadata.name]: 'keep-current',
  },
});
assert.ok(events.length > 0);

const reviewSession = {
  id: 'survey-session-1',
  proposalId: proposal.id,
  sessionName: events[0]!.spec.sessionName,
  snapshot,
  snapshotHash: hashSurveyReviewSnapshot(snapshot),
  proposalStatus: proposal.status,
  createdBy: 'operator@example.test',
  createdAt: '2026-06-01T12:00:00.000Z',
  updatedAt: '2026-06-01T12:00:00.000Z',
  appliedAt: null,
} satisfies SurveyReviewSessionRecord;

assert.equal(hashSurveyReviewSnapshot(snapshot), hashSurveyReviewSnapshot({ ...snapshot }));
assert.equal(
  hashSurveyReviewSnapshot(snapshot),
  hashSurveyReviewSnapshot(JSON.parse(JSON.stringify(snapshot))),
  'Survey snapshot hash should survive JSONB storage round trips',
);
assertSurveyReviewSessionFreshForProposal(reviewSession, proposal);
validateSurveyReviewEventsForSession(reviewSession, events);

assert.throws(
  () => validateSurveyReviewEventsForSession(reviewSession, [
    {
      ...events[0]!,
      spec: {
        ...events[0]!.spec,
        sessionName: 'browser-invented-session',
      },
    },
  ]),
  SurveyReviewEventValidationError,
);

assert.throws(
  () => validateSurveyReviewEventsForSession(reviewSession, [
    {
      ...events[0]!,
      spec: {
        ...events[0]!.spec,
        reviewItemName: 'camp-proposal-other-field',
      },
    },
  ]),
  SurveyReviewEventValidationError,
);

assert.throws(
  () => validateSurveyReviewEventsForSession(reviewSession, [
    {
      ...events[0]!,
      spec: {
        ...events[0]!.spec,
        reviewItemName: description.metadata.name,
        candidateId: 'candidate-outside-snapshot',
      },
    },
  ]),
  SurveyReviewEventValidationError,
);

assert.throws(
  () => assertSurveyReviewSessionFreshForProposal(reviewSession, {
    ...proposal,
    proposedChanges: {
      ...proposal.proposedChanges,
      description: {
        ...proposal.proposedChanges.description!,
        new: 'A different extracted value.',
      },
    },
  }),
  SurveyReviewSessionStaleError,
);

console.log('survey server-owned session verification passed');
