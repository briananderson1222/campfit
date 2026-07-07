/**
 * tests/integration/schedule-panel-view.test.ts — campfit#92 Wave 3 unit
 * coverage for `app/admin/crawls/schedule-panel-view.ts`'s pure formatting
 * helpers.
 *
 * `schedule-panel.tsx` itself (the `'use client'` component that consumes
 * these helpers) has no runnable render test in this repo — no jsdom/
 * testing-library harness exists (verified: zero `.test.tsx` files, no
 * `testing-library` dependency) and it is a hooks-bearing client component,
 * not an `async` Server Component callable directly the way
 * `admin-crawl-failures-page.test.ts` calls `CrawlFailuresPage()`. That gap
 * is accepted per campfit#96 (open, tracked there), matching the same
 * accepted-gap framing the plan already applies to `crawl-runner-button.tsx`
 * and the schedule panel itself (`scheduled-crawls--plan.md`, Wave 3 task's
 * own Acceptance note). This file exercises everything in that panel that
 * *can* be tested without a render harness: the plain, React-free formatting
 * functions the panel imports.
 *
 * No real Postgres/network dependency — these are pure functions over plain
 * data, run under the shared `vitest.config.ts` (`environment: "node"`)
 * alongside the rest of `tests/integration/**`.
 */
import { describe, expect, it } from 'vitest';

import {
  BATCH_SIZE_OPTIONS,
  PRIORITY_COPY,
  priorityLabel,
  formatUtcTimestamp,
  describeLastRun,
  describeNextRun,
  type ScheduleLastRun,
} from '@/app/admin/crawls/schedule-panel-view';

describe('BATCH_SIZE_OPTIONS / PRIORITY_COPY — matches the route\'s own server-side ceilings', () => {
  it('offers exactly the {5,10} batch sizes the admin route validates (never 20/50)', () => {
    expect(BATCH_SIZE_OPTIONS).toEqual([5, 10]);
  });

  it('covers exactly the cron-automation priority vocabulary (stale, never_crawled)', () => {
    expect(Object.keys(PRIORITY_COPY).sort()).toEqual(['never_crawled', 'stale']);
  });

  it('priorityLabel reuses crawl-modal.tsx\'s existing copy verbatim', () => {
    expect(priorityLabel('stale')).toBe('Most Stale');
    expect(priorityLabel('never_crawled')).toBe('Never Crawled');
  });
});

describe('formatUtcTimestamp', () => {
  it('formats an ISO timestamp in UTC, not the local test-runner timezone', () => {
    const label = formatUtcTimestamp('2026-07-08T09:00:00.000Z');
    expect(label).toContain('2026');
    expect(label).toContain('9:00');
    expect(label).toMatch(/UTC|GMT/);
  });
});

describe('describeLastRun', () => {
  it('reports "No scheduled run yet" when there is no last run', () => {
    expect(describeLastRun(null)).toBe('No scheduled run yet');
  });

  it('includes status, processed/total camps, and the started-at timestamp', () => {
    const lastRun: ScheduleLastRun = {
      id: 'run-1',
      status: 'COMPLETED',
      startedAt: '2026-07-06T09:00:00.000Z',
      completedAt: '2026-07-06T09:05:00.000Z',
      processedCamps: 5,
      totalCamps: 5,
      errorCount: 0,
    };
    const text = describeLastRun(lastRun);
    expect(text).toContain('COMPLETED');
    expect(text).toContain('5/5 camps');
    expect(text).not.toContain('error');
    expect(text).toContain('2026');
  });

  it('surfaces a non-zero error count, pluralized correctly', () => {
    const base: ScheduleLastRun = {
      id: 'run-2', status: 'FAILED', startedAt: '2026-07-06T09:00:00.000Z',
      completedAt: null, processedCamps: 2, totalCamps: 5, errorCount: 1,
    };
    expect(describeLastRun(base)).toContain(', 1 error');
    expect(describeLastRun({ ...base, errorCount: 3 })).toContain(', 3 errors');
  });

  it('reports "no camps" when totalCamps is 0 (matches the crawl-monitor card\'s own zero-camp copy convention)', () => {
    const lastRun: ScheduleLastRun = {
      id: 'run-3', status: 'FAILED', startedAt: '2026-07-06T09:00:00.000Z',
      completedAt: '2026-07-06T09:01:00.000Z', processedCamps: 0, totalCamps: 0, errorCount: 0,
    };
    expect(describeLastRun(lastRun)).toContain('no camps');
  });
});

describe('describeNextRun', () => {
  it('reports "Scheduling is disabled" when the schedule is off, regardless of the computed next-run timestamp', () => {
    expect(describeNextRun('2026-07-08T09:00:00.000Z', false)).toBe('Scheduling is disabled');
  });

  it('reports the formatted next-run timestamp when enabled', () => {
    const text = describeNextRun('2026-07-08T09:00:00.000Z', true);
    expect(text).toContain('Next run');
    expect(text).toContain('2026');
  });
});
