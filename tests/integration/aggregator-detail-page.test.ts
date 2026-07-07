/**
 * tests/integration/aggregator-detail-page.test.ts — Server Component
 * wiring + real-markup coverage for `app/admin/aggregators/[id]/page.tsx`
 * (campfit#93, Wave 3 Task 3.2 + Wave 4 Task 4.2's wiring).
 *
 * `AggregatorDetailPage` is an `async` Server Component (a plain function,
 * no hooks) — called directly, per `admin-crawl-failures-page.test.ts`'s
 * precedent. `@/lib/admin/access`, the aggregator repository, `next/
 * navigation`'s `notFound`, `./tos-decision-form`, and `./run-discovery-
 * button` are mocked at the import boundary: the latter two are genuine
 * `'use client'` components that call `useRouter()` unconditionally, which
 * throws outside a real App Router tree (campfit#96 accepted gap, same
 * limitation documented across this repo's existing render tests).
 * `./tos-receipt` (`TosReceiptWithRedecide`) and `./candidates-panel`
 * (`CandidatesPanel`) are deliberately LEFT UNMOCKED and rendered for
 * real: neither calls `useRouter()` (only `useState`, and
 * `CandidatesPanel`'s `useEffect` never fires during a static server
 * render, so it renders its initial `'loading'` state) — genuine coverage,
 * not faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const requireAdminAccess = vi.fn();
vi.mock('@/lib/admin/access', () => ({
  requireAdminAccess: (...args: unknown[]) => requireAdminAccess(...args),
}));

const getAggregatorSource = vi.fn();
vi.mock('@/lib/ingestion/aggregator/aggregator-repository', () => ({
  getAggregatorSource: (...args: unknown[]) => getAggregatorSource(...args),
}));

class NotFoundSentinel extends Error {}
const notFound = vi.fn(() => { throw new NotFoundSentinel('NEXT_NOT_FOUND'); });
vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
}));

vi.mock('@/app/admin/aggregators/[id]/tos-decision-form', async () => {
  const { createElement } = await import('react');
  return {
    TosDecisionForm: (props: { aggregatorId: string; mode?: string }) =>
      createElement('div', { 'data-testid': 'tos-decision-form-stub' }, `tos-form:${props.aggregatorId}:${props.mode}`),
  };
});

vi.mock('@/app/admin/aggregators/[id]/run-discovery-button', async () => {
  const { createElement } = await import('react');
  return {
    RunDiscoveryButton: (props: { aggregatorId: string; tosApproved: boolean }) =>
      createElement('div', { 'data-testid': 'run-discovery-stub' }, `run-discovery:${props.aggregatorId}:${String(props.tosApproved)}`),
  };
});

import AggregatorDetailPage from '@/app/admin/aggregators/[id]/page';

function baseAggregator(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'agg-1',
    name: 'Camp Finder',
    url: 'https://campfinder.example',
    communitySlug: 'denver',
    maxPages: 20,
    maxDepth: 2,
    status: 'REGISTERED',
    tosDecision: null,
    tosReviewedBy: null,
    tosReviewedAt: null,
    tosNotes: null,
    createdBy: 'admin@campfit.test',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AggregatorDetailPage — not-found paths', () => {
  it('calls notFound() when the aggregator row does not exist, never checking auth', async () => {
    getAggregatorSource.mockResolvedValue(null);

    await expect(AggregatorDetailPage({ params: Promise.resolve({ id: 'missing' }) })).rejects.toThrow(NotFoundSentinel);
    expect(requireAdminAccess).not.toHaveBeenCalled();
  });

  it('calls notFound() when auth fails, scoped to the row\'s own communitySlug', async () => {
    getAggregatorSource.mockResolvedValue(baseAggregator({ communitySlug: 'boulder' }));
    requireAdminAccess.mockResolvedValue({ error: 'Forbidden', status: 403 });

    await expect(AggregatorDetailPage({ params: Promise.resolve({ id: 'agg-1' }) })).rejects.toThrow(NotFoundSentinel);
    expect(requireAdminAccess).toHaveBeenCalledWith({ communitySlug: 'boulder', allowModerator: true });
  });
});

describe('AggregatorDetailPage — ToS gate rendering (R1/AC1, prominence)', () => {
  it('renders the prominent TosDecisionForm in "initial" mode when tosDecision is null, and RunDiscoveryButton with tosApproved=false', async () => {
    getAggregatorSource.mockResolvedValue(baseAggregator());
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });

    const page = await AggregatorDetailPage({ params: Promise.resolve({ id: 'agg-1' }) });
    const html = renderToStaticMarkup(page as ReactElement);

    expect(html).toContain('tos-form:agg-1:initial');
    expect(html).toContain('run-discovery:agg-1:false');
    expect(html).not.toContain('ToS Approved');
    expect(html).not.toContain('ToS Declined');
  });

  it('renders the real read-only receipt (TosReceiptWithRedecide) + RunDiscoveryButton tosApproved=true once APPROVED', async () => {
    getAggregatorSource.mockResolvedValue(baseAggregator({
      tosDecision: 'APPROVED',
      status: 'ACTIVE',
      tosReviewedBy: 'admin@campfit.test',
      tosReviewedAt: new Date('2026-07-02T00:00:00Z'),
      tosNotes: 'Reviewed ToS, listing scrape is permitted for non-commercial use.',
    }));
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });

    const page = await AggregatorDetailPage({ params: Promise.resolve({ id: 'agg-1' }) });
    const html = renderToStaticMarkup(page as ReactElement);

    expect(html).toContain('ToS Approved');
    expect(html).toContain('admin@campfit.test');
    expect(html).toContain('Reviewed ToS, listing scrape is permitted');
    expect(html).toContain('Change decision');
    expect(html).not.toContain('tos-form:'); // TosDecisionForm's redecide form is collapsed by default
    expect(html).toContain('run-discovery:agg-1:true');
  });

  it('renders the real read-only receipt in the DECLINED state', async () => {
    getAggregatorSource.mockResolvedValue(baseAggregator({
      tosDecision: 'DECLINED',
      status: 'DECLINED',
      tosReviewedBy: 'admin@campfit.test',
      tosReviewedAt: new Date('2026-07-02T00:00:00Z'),
    }));
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });

    const page = await AggregatorDetailPage({ params: Promise.resolve({ id: 'agg-1' }) });
    const html = renderToStaticMarkup(page as ReactElement);

    expect(html).toContain('ToS Declined');
    expect(html).toContain('run-discovery:agg-1:false');
  });
});

describe('AggregatorDetailPage — candidates panel wiring (R3/AC3)', () => {
  it('mounts the real CandidatesPanel scoped to this aggregator id (renders its initial loading state, no fetch during static render)', async () => {
    getAggregatorSource.mockResolvedValue(baseAggregator());
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });

    const page = await AggregatorDetailPage({ params: Promise.resolve({ id: 'agg-1' }) });
    const html = renderToStaticMarkup(page as ReactElement);
    expect(html).toContain('Loading candidates');
  });
});

describe('AggregatorDetailPage — header content', () => {
  it('renders the aggregator name/url/status/community as real markup', async () => {
    getAggregatorSource.mockResolvedValue(baseAggregator({ status: 'REGISTERED' }));
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });

    const page = await AggregatorDetailPage({ params: Promise.resolve({ id: 'agg-1' }) });
    const html = renderToStaticMarkup(page as ReactElement);

    expect(html).toContain('Camp Finder');
    expect(html).toContain('https://campfinder.example');
    expect(html).toContain('Registered');
    expect(html).toContain('denver');
  });
});
