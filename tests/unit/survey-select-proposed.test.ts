import { buildReviewSessionEvents } from '@kontourai/survey/review-workbench';
import { describe, expect, it } from 'vitest';

import { deriveCampApplyFromSurveySession, SurveyReviewApplyError } from '@/lib/admin/survey-review-apply';
import { buildCampSurveyReviewQueueSession } from '@/lib/admin/survey-review-items';
import type { CampChangeProposal } from '@/lib/admin/types';

const proposal = {
  id: 'proposal-select-1', campId: 'camp-select-1', crawlRunId: 'crawl-select-1',
  createdAt: '2026-06-01T11:45:00.000Z', reviewedAt: null, reviewedBy: null, status: 'PENDING',
  sourceUrl: 'https://example.test/camps/summer', rawExtraction: {},
  proposedChanges: {
    city: { old: 'Denver', new: 'Boulder', confidence: 0.9, excerpt: 'Boulder', sourceUrl: 'https://example.test/camps/summer', mode: 'update' },
  },
  overallConfidence: 0.9, extractionModel: 'fixture-model', reviewerNotes: null, feedbackTags: [], priority: 0,
  appliedFields: [], campName: 'Example Camp', campSlug: 'example-camp', communitySlug: 'denver', providerId: 'p1',
  lastVerifiedAt: null, campData: {}, fieldTimeline: {},
  crawlStartedAt: '2026-06-01T11:40:00.000Z', crawlCompletedAt: '2026-06-01T11:44:00.000Z',
  crawlTrigger: 'MANUAL', crawlTriggeredBy: 'op@example.test',
} as unknown as CampChangeProposal;

describe('Survey 7 select-proposed on a CampFit review item', () => {
  it('is never applied as an approval or a rejection', () => {
    const session = buildCampSurveyReviewQueueSession(proposal, { actorId: 'op@example.test', reviewedAt: '2026-06-01T12:00:00.000Z' });
    const [item] = session.items;
    const proposed = item!.spec.candidates.find((candidate) => candidate.role === 'proposed')!;
    // The workbench cannot build a select-proposed decision on a one-proposed
    // item; a submitted event stream can still carry one, so it is forged
    // from an accepted decision.
    const accepted = buildReviewSessionEvents({
      ...session,
      decisionsByItemName: { [item!.metadata.name]: 'accept-proposed' },
    }, 'campfit-select-proposed');
    const events = JSON.parse(
      JSON.stringify(accepted).replaceAll('"accept-proposed"', '"select-proposed"'),
    ) as typeof accepted;
    expect(JSON.stringify(events)).toContain('select-proposed');
    expect(proposed.id).toBeTruthy();

    expect(() => deriveCampApplyFromSurveySession({ proposal, session, events })).toThrow(SurveyReviewApplyError);
  });
});
