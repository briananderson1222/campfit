import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildReviewSessionEvents, defaultReviewSessionName, renderReviewWorkbenchHtml } from '@kontourai/survey/review-workbench';
import type { ReviewQueueSessionState } from '@kontourai/survey/review-workbench';
import { describe, expect, it } from 'vitest';

import { ReviewDetailHeading } from '@/app/admin/review/[id]/review-detail-heading';
import { NewCampMarker } from '@/app/admin/review/new-camp-marker';
import { SurveyReviewWorkbench } from '@/components/admin/survey-review-workbench';
import { createCampSurveyPresentationAdapter } from '@/lib/admin/survey-presentation';
import { buildCampSurveyReviewQueueSession } from '@/lib/admin/survey-review-items';
import { hashSurveyReviewSnapshot, type SurveyReviewSessionRecord } from '@/lib/admin/survey-review-sessions';
import { validateSurveyReviewEventsForSession } from '@/lib/admin/survey-review-events';
import type { CampChangeProposal } from '@/lib/admin/types';

function freshDiscoveryProposal(): CampChangeProposal {
  return {
    id: 'fresh-proposal-1',
    campId: 'fresh-camp-1',
    crawlRunId: 'crawl-1',
    createdAt: '2026-07-13T12:00:00.000Z',
    reviewedAt: null,
    reviewedBy: null,
    status: 'PENDING',
    sourceUrl: 'https://aggregator.example.test/pine-ridge',
    rawExtraction: {},
    proposedChanges: {
      name: { old: null, new: 'Pine Ridge Camp', confidence: 0.98, mode: 'populate', excerpt: 'Pine Ridge Camp', sourceUrl: 'https://aggregator.example.test/pine-ridge' },
      city: { old: null, new: 'Denver', confidence: 0.92, excerpt: 'Located in Denver', sourceUrl: 'https://aggregator.example.test/pine-ridge' },
    },
    overallConfidence: 0.95,
    extractionModel: 'test-model',
    reviewerNotes: null,
    feedbackTags: null,
    priority: 0,
    appliedFields: [],
    campName: 'Discovery placeholder',
    communitySlug: 'denver',
  };
}

describe('fresh-discovery review presentation', () => {
  it('frames the detail heading around the proposed new camp name', () => {
    const html = renderToStaticMarkup(createElement(ReviewDetailHeading, { proposal: freshDiscoveryProposal() }));
    expect(html).toContain('data-review-new-camp="true"');
    expect(html).toContain('NEW CAMP');
    expect(html).toContain('Review new camp: Pine Ridge Camp');
    expect(html).not.toContain('Review new camp: Discovery placeholder');
  });

  it('replaces the meaningless null current candidate presentation with an honest new-camp state', () => {
    const session = buildCampSurveyReviewQueueSession(freshDiscoveryProposal(), {
      actorId: 'owner@campfit.test',
      reviewedAt: '2026-07-13T12:30:00.000Z',
    });
    const html = renderToStaticMarkup(createElement(SurveyReviewWorkbench, { session, isNewCamp: true }));

    expect(html).toContain('data-new-camp-current-state="true"');
    expect(html).toContain('no existing value — new camp');
    expect(html).not.toContain('data-candidate-role="current"');
    expect(html).toContain('data-candidate-role="proposed"');
    expect(html).toContain('Pine Ridge Camp');
  });

  it('adapts the actual mounted Survey workbench current candidates for a new camp', () => {
    const session = buildCampSurveyReviewQueueSession(freshDiscoveryProposal(), {
      actorId: 'owner@campfit.test',
      reviewedAt: '2026-07-13T12:30:00.000Z',
    });
    const mountedHtml = renderReviewWorkbenchHtml(session, [], {
      presentationAdapter: createCampSurveyPresentationAdapter({}, { newCamp: true }),
    });

    expect(mountedHtml).toContain('No existing value — new camp');
    expect(mountedHtml).toContain('no existing value — new camp');
    expect(mountedHtml).not.toContain('>empty<');
  });

  it('shows the needs-review New camp marker only for an all-populate proposal', () => {
    const populateHtml = renderToStaticMarkup(createElement(NewCampMarker, {
      proposedChanges: freshDiscoveryProposal().proposedChanges,
    }));
    const diffHtml = renderToStaticMarkup(createElement(NewCampMarker, {
      proposedChanges: { city: { old: 'Boulder', new: 'Denver', confidence: 0.9 } },
    }));

    expect(populateHtml).toContain('data-new-camp-marker="true"');
    expect(populateHtml).toContain('New camp');
    expect(diffHtml).toBe('');
  });

  it('keeps fresh-discovery Survey review events valid for the persisted session contract', () => {
    const snapshot = buildCampSurveyReviewQueueSession(freshDiscoveryProposal(), {
      actorId: 'owner@campfit.test',
      reviewedAt: '2026-07-13T12:30:00.000Z',
    });
    const events = buildReviewSessionEvents({
      ...(snapshot as ReviewQueueSessionState),
      decisionsByItemName: {
        [snapshot.items[0]!.metadata.name]: 'accept-proposed',
      },
    });
    const record: SurveyReviewSessionRecord = {
      id: 'session-1',
      proposalId: 'fresh-proposal-1',
      sessionName: defaultReviewSessionName,
      snapshot,
      snapshotHash: hashSurveyReviewSnapshot(snapshot),
      proposalStatus: 'PENDING',
      createdBy: 'owner@campfit.test',
      createdAt: '2026-07-13T12:30:00.000Z',
      updatedAt: '2026-07-13T12:30:00.000Z',
      appliedAt: null,
    };

    expect(() => validateSurveyReviewEventsForSession(record, events)).not.toThrow();
  });
});
