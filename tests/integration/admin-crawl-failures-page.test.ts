/**
 * tests/integration/admin-crawl-failures-page.test.ts — campfit#85
 * code-review finding M3: `app/admin/crawl-failures/page.tsx` must render a
 * minimal "Unassigned source failures" section backed by
 * `getUnassignedSourceFailures()`, closing the operator-visibility gap the
 * review flagged (a source-sweep failure was queryable at the data layer
 * but invisible on every admin screen).
 *
 * No `@testing-library/react`/JSX-rendering harness exists in this repo
 * (verified: no `.test.tsx` files, no `testing-library` dependency) — this
 * file uses `react-dom/server`'s `renderToStaticMarkup` (already a
 * dependency of this Next.js app) for HTML-text assertions, and calls the
 * exported async Server Component (`CrawlFailuresPage`) directly — per
 * `onboard-url-outcomes.test.ts`'s precedent of calling a route/page
 * function directly and asserting on its output — for wiring/props
 * assertions. `@/lib/admin/access` and `@/lib/admin/crawl-failure-repository`
 * are mocked at the import boundary (source files untouched).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const requireAdminAccess = vi.fn();
vi.mock('@/lib/admin/access', () => ({
  requireAdminAccess: (...args: unknown[]) => requireAdminAccess(...args),
}));

const getUncrawlableCamps = vi.fn();
const getUnassignedSourceFailures = vi.fn();
vi.mock('@/lib/admin/crawl-failure-repository', () => ({
  getUncrawlableCamps: (...args: unknown[]) => getUncrawlableCamps(...args),
  getUnassignedSourceFailures: (...args: unknown[]) => getUnassignedSourceFailures(...args),
}));

import CrawlFailuresPage from '@/app/admin/crawl-failures/page';
import { CrawlFailuresTable } from '@/app/admin/crawl-failures/crawl-failures-table';
import { UnassignedSourceFailuresTable } from '@/app/admin/crawl-failures/unassigned-source-failures-table';

function findChildOfType(element: ReactElement, type: unknown): ReactElement | undefined {
  const children = (element.props as { children?: unknown }).children;
  const list = Array.isArray(children) ? children : [children];
  return list.find((child): child is ReactElement => {
    return !!child && typeof child === 'object' && 'type' in (child as object) && (child as ReactElement).type === type;
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CrawlFailuresPage — unassigned source failures section (campfit#85 review M3)', () => {
  it('renders null (no access) for an unauthorized visitor, never calling either repository query', async () => {
    requireAdminAccess.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const result = await CrawlFailuresPage();
    expect(result).toBeNull();
    expect(getUncrawlableCamps).not.toHaveBeenCalled();
    expect(getUnassignedSourceFailures).not.toHaveBeenCalled();
  });

  it('fetches getUnassignedSourceFailures() and renders its rows in a dedicated section alongside the existing uncrawlable-camps table', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });
    getUncrawlableCamps.mockResolvedValue([]);
    getUnassignedSourceFailures.mockResolvedValue([
      {
        sourceKey: 'avid4',
        latestError: 'traverse-recrawl:provider-unavailable: ZAI_API_KEY is not set',
        latestUrl: 'https://avid4.com/day-camps/colorado/',
        latestRunId: 'run-1',
        latestStartedAt: '2026-07-06T00:00:00.000Z',
        failureCount: 3,
      },
    ]);

    const page = await CrawlFailuresPage();
    expect(page).not.toBeNull();

    expect(getUnassignedSourceFailures).toHaveBeenCalledTimes(1);
    expect(getUnassignedSourceFailures).toHaveBeenCalledWith({ limit: 100 });

    const root = page as ReactElement;
    const crawlFailuresTable = findChildOfType(root, CrawlFailuresTable);
    const unassignedTable = findChildOfType(root, UnassignedSourceFailuresTable);

    expect(crawlFailuresTable).toBeDefined();
    expect(unassignedTable).toBeDefined();
    expect((unassignedTable!.props as { rows: unknown[] }).rows).toHaveLength(1);
    expect((unassignedTable!.props as { rows: { sourceKey: string }[] }).rows[0].sourceKey).toBe('avid4');

    // Rendered HTML actually surfaces the failure — the operator-visibility
    // gap the review flagged (queryable but not rendered anywhere).
    const html = renderToStaticMarkup(root);
    expect(html).toContain('avid4');
    expect(html).toContain('Unassigned Source Failures');
  });

  it('falls back to an empty array (never throws) if getUnassignedSourceFailures rejects', async () => {
    requireAdminAccess.mockResolvedValue({ access: { isAdmin: true, communities: [] } });
    getUncrawlableCamps.mockResolvedValue([]);
    getUnassignedSourceFailures.mockRejectedValue(new Error('db blip'));

    const page = await CrawlFailuresPage();
    const root = page as ReactElement;
    const unassignedTable = findChildOfType(root, UnassignedSourceFailuresTable);
    expect((unassignedTable!.props as { rows: unknown[] }).rows).toEqual([]);
  });
});

describe('UnassignedSourceFailuresTable — minimal display + count, no actions (campfit#85 review M3)', () => {
  it('shows an empty-state message matching CrawlFailuresTable\'s empty-state styling convention when there are no rows', () => {
    const html = renderToStaticMarkup(UnassignedSourceFailuresTable({ rows: [] }));
    expect(html).toContain('No unassigned source failures in the last 45 days.');
    // Same empty-state visual convention as CrawlFailuresTable's own
    // "glass-panel ... text-center text-bark-300" empty state.
    expect(html).toContain('glass-panel');
    expect(html).toContain('text-center');
  });

  it("renders the failure count and each row's sourceKey/latestError, and never renders an action button (retry/save/hint)", () => {
    const rows = [
      {
        sourceKey: 'avid4',
        latestError: 'traverse-recrawl:provider-unavailable: ZAI_API_KEY is not set',
        latestUrl: 'https://avid4.com/day-camps/colorado/',
        latestRunId: 'run-1',
        latestStartedAt: '2026-07-06T00:00:00.000Z',
        failureCount: 3,
      },
    ];
    const html = renderToStaticMarkup(UnassignedSourceFailuresTable({ rows }));
    expect(html).toContain('avid4');
    expect(html).toContain('traverse-recrawl:provider-unavailable');
    expect(html).toContain('3');
    expect(html).toContain('1 unassigned source failure');
    expect(html).not.toContain('<button');
  });
});
