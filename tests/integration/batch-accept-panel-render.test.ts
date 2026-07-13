/**
 * tests/integration/batch-accept-panel-render.test.ts — direct
 * `renderToStaticMarkup` coverage for `batch-accept-panel.tsx`'s initial
 * render (campfit#51, Wave 3 Task 3.2), following
 * `candidates-panel-render.test.ts`'s exact precedent: `BatchAcceptPanel`
 * calls `useRouter()` internally, so — unlike `CandidatesPanel` — its render
 * requires an `AppRouterContext` provider, matching
 * `run-discovery-button.tsx`'s own render-test idiom (see that file's own
 * test, if any) rather than `candidates-panel-render.test.ts`'s router-free
 * one. `BatchAcceptPanel` has no `useEffect` (no fetch-on-mount — the
 * `RankedProposal[]` prop is server-rendered by `page.tsx`), so a static
 * render is genuine, complete coverage of both its empty state and its
 * populated state (unlike `CandidatesPanel`, whose static render only ever
 * shows its loading placeholder).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { describe, expect, it } from 'vitest';

import { BatchAcceptPanel } from '@/app/admin/review/batch-accept-panel';
import type { RankedProposal } from '@/lib/admin/review-repository';

const mockRouter = {
  back: () => {},
  forward: () => {},
  push: () => {},
  replace: () => {},
  refresh: () => {},
  prefetch: () => Promise.resolve(),
};

function renderWithRouter(node: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: mockRouter as never }, node),
  );
}

function proposal(overrides: Partial<RankedProposal> = {}): RankedProposal {
  return {
    id: 'proposal-1',
    campId: 'camp-1',
    crawlRunId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    reviewedAt: null,
    reviewedBy: null,
    status: 'PENDING',
    sourceUrl: 'https://example.test/camp',
    rawExtraction: {},
    proposedChanges: {
      city: { old: '', new: 'Austin', confidence: 0.9 },
    },
    overallConfidence: 0.9,
    extractionModel: 'test-model',
    reviewerNotes: null,
    feedbackTags: null,
    priority: 0,
    appliedFields: [],
    campName: 'Test Camp',
    communitySlug: 'denver',
    fieldCorroboration: {
      city: { field: 'city', value: 'Austin', exact: true, corroboratingProposalIds: ['other'], corroboratingSourceUrls: ['https://a.test'], sameSourceUrl: false },
    },
    batchEligibleFieldCount: 1,
    shadowAutoAccept: false,
    ...overrides,
  };
}

describe('BatchAcceptPanel — initial static render', () => {
  it('renders the empty state when there are no batch-ready proposals', () => {
    const html = renderWithRouter(createElement(BatchAcceptPanel, { proposals: [] }));
    expect(html).toContain('No batch-ready proposals');
  });

  it('renders a proposal card with a selectable chip for a corroborated field', () => {
    const html = renderWithRouter(createElement(BatchAcceptPanel, { proposals: [proposal()] }));
    expect(html).toContain('Test Camp');
    expect(html).toContain('city');
    expect(html).toContain('Batch accept (0 selected)');
    expect(html).toContain('type="checkbox"');
  });

  it('renders the advisory shadow badge only for a shadow-pass proposal', () => {
    const passHtml = renderWithRouter(createElement(BatchAcceptPanel, { proposals: [proposal({ shadowAutoAccept: true })] }));
    const failHtml = renderWithRouter(createElement(BatchAcceptPanel, { proposals: [proposal({ shadowAutoAccept: false })] }));
    expect(passHtml).toContain('data-shadow-auto-accept="true"');
    expect(passHtml).toContain('would auto-accept');
    expect(failHtml).not.toContain('data-shadow-auto-accept');
  });
});
