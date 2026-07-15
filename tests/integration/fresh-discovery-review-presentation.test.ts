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

  it('mounts the themed workbench host for a new-camp session (field-diff is client-rendered)', () => {
    const session = buildCampSurveyReviewQueueSession(freshDiscoveryProposal(), {
      actorId: 'owner@campfit.test',
      reviewedAt: '2026-07-13T12:30:00.000Z',
    });
    // The consolidated workbench mounts client-side (mountReviewWorkbench in a
    // useEffect), so its server markup is the campfit-themed mount host. The
    // new-camp current state is rendered inside that workbench — asserted against
    // the actual Survey render in the next test.
    const html = renderToStaticMarkup(createElement(SurveyReviewWorkbench, { session, isNewCamp: true }));

    expect(html).toContain('survey-workbench-embed');
    expect(html).toContain('theme-campfit');
    expect(html).toContain('aria-label="Survey review workbench"');
  });

  it('renders an honest new-camp current state (Not set + New) instead of a meaningless null', () => {
    const session = buildCampSurveyReviewQueueSession(freshDiscoveryProposal(), {
      actorId: 'owner@campfit.test',
      reviewedAt: '2026-07-13T12:30:00.000Z',
    });
    const mountedHtml = renderReviewWorkbenchHtml(session, [], {
      presentationAdapter: createCampSurveyPresentationAdapter({}, { newCamp: true }),
    });

    // Survey 1.12.0 shows an empty current value as "Not set" and marks the field
    // "New" — an honest new-camp representation, never a raw null/empty candidate.
    expect(mountedHtml).toContain('Not set');
    expect(mountedHtml).toContain('<span class="fkind">New</span>');
    expect(mountedHtml).toContain('Pine Ridge Camp');
    expect(mountedHtml).not.toContain('>empty<');
    expect(mountedHtml).not.toContain('>null<');
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
