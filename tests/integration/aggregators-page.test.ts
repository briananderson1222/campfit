/**
 * tests/integration/aggregators-page.test.ts — Server Component wiring +
 * real-markup coverage for `app/admin/aggregators/page.tsx` (campfit#93
 * Wave 3, Task 3.2).
 *
 * `AdminAggregatorsPage` is an `async` Server Component (a plain function,
 * no hooks) — called directly and asserted on, per
 * `admin-crawl-failures-page.test.ts`'s precedent (`@/lib/admin/access` and
 * the repository module are mocked at the import boundary; source files
 * untouched). `./register-form` (`RegisterAggregatorForm`) is ALSO mocked
 * at the import boundary here — it is a genuine `'use client'` component
 * that calls `next/navigation`'s `useRouter()` unconditionally, which
 * throws outside a real App Router tree (the same documented limitation
 * `review-format-badge.test.ts`/`review-provenance-marker.test.ts` record
 * for this repo's lack of a jsdom/testing-library harness — campfit#96,
 * accepted gap). The stub renders its `defaultCommunitySlug` prop into
 * visible text so this file can still assert the page passed the right
 * value through real `renderToStaticMarkup` output, not just an
 * un-rendered element's raw props.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const requireAdminAccess = vi.fn();
vi.mock('@/lib/admin/access', () => ({
  requireAdminAccess: (...args: unknown[]) => requireAdminAccess(...args),
}));

const listAggregatorSources = vi.fn();
vi.mock('@/lib/ingestion/aggregator/aggregator-repository', () => ({
  listAggregatorSources: (...args: unknown[]) => listAggregatorSources(...args),
}));

vi.mock('@/app/admin/aggregators/register-form', async () => {
  const { createElement } = await import('react');
  return {
    RegisterAggregatorForm: (props: { defaultCommunitySlug: string }) =>
      createElement('div', { 'data-testid': 'register-form-stub' }, `register-form-stub:${props.defaultCommunitySlug}`),
  };
});

import AdminAggregatorsPage from '@/app/admin/aggregators/page';

afterEach(() => {
  vi.clearAllMocks();
});

describe('AdminAggregatorsPage — auth gate', () => {
  it('returns null (no access) for an unauthorized visitor, never listing aggregators', async () => {
    requireAdminAccess.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const page = await AdminAggregatorsPage();
    expect(page).toBeNull();
    expect(listAggregatorSources).not.toHaveBeenCalled();
  });
});

describe('AdminAggregatorsPage — admin view', () => {
  it('lists all communities (undefined slug) for an isAdmin session and passes "denver" as the register-form default', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });
    listAggregatorSources.mockResolvedValue([]);

    const page = await AdminAggregatorsPage();
    expect(page).not.toBeNull();
    expect(listAggregatorSources).toHaveBeenCalledTimes(1);
    expect(listAggregatorSources).toHaveBeenCalledWith(undefined);

    const html = renderToStaticMarkup(page as ReactElement);
    expect(html).toContain('register-form-stub:denver');
  });

  it('renders the ToS gate / status badges and aggregator rows as real markup, including a "ToS review required" row', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });
    listAggregatorSources.mockResolvedValue([
      {
        id: 'agg-1', name: 'Camp Finder', url: 'https://campfinder.example', communitySlug: 'denver',
        maxPages: 20, maxDepth: 2, status: 'REGISTERED', tosDecision: null,
        tosReviewedBy: null, tosReviewedAt: null, tosNotes: null, createdBy: 'admin@campfit.test',
        createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
      },
      {
        id: 'agg-2', name: 'Rec Roundup', url: 'https://recroundup.example', communitySlug: 'denver',
        maxPages: 10, maxDepth: 1, status: 'ACTIVE', tosDecision: 'APPROVED',
        tosReviewedBy: 'admin@campfit.test', tosReviewedAt: new Date('2026-07-02T00:00:00Z'), tosNotes: null,
        createdBy: 'admin@campfit.test', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-02T00:00:00Z'),
      },
    ]);

    const page = await AdminAggregatorsPage();
    const html = renderToStaticMarkup(page as ReactElement);

    expect(html).toContain('2 aggregators');
    expect(html).toContain('Camp Finder');
    expect(html).toContain('Rec Roundup');
    expect(html).toContain('Registered');
    expect(html).toContain('Active');
    expect(html).toContain('ToS review required');
    expect(html).toContain('ToS Approved');
    expect(html).toContain('register-form-stub');
  });

  it('shows the empty state when there are no aggregators', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });
    listAggregatorSources.mockResolvedValue([]);

    const page = await AdminAggregatorsPage();
    const html = renderToStaticMarkup(page as ReactElement);
    expect(html).toContain('No aggregators registered yet');
    expect(html).toContain('0 aggregators');
  });

  it('falls back to an empty list (never throws) if listAggregatorSources rejects', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });
    listAggregatorSources.mockRejectedValue(new Error('db blip'));

    const page = await AdminAggregatorsPage();
    const html = renderToStaticMarkup(page as ReactElement);
    expect(html).toContain('No aggregators registered yet');
  });
});

describe('AdminAggregatorsPage — moderator (community-scoped) view', () => {
  it('queries listAggregatorSources per assigned community, never the global (undefined) list', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: false, communities: ['boulder'] } });
    listAggregatorSources.mockResolvedValue([]);

    await AdminAggregatorsPage();
    expect(listAggregatorSources).toHaveBeenCalledTimes(1);
    expect(listAggregatorSources).toHaveBeenCalledWith('boulder');
    expect(listAggregatorSources).not.toHaveBeenCalledWith(undefined);
  });
});
