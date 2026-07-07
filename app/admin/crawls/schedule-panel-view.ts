/**
 * app/admin/crawls/schedule-panel-view.ts — pure, framework-free formatting
 * helpers for `schedule-panel.tsx` (campfit#92, Wave 3).
 *
 * Split out from the `'use client'` panel component specifically so this
 * logic has a real unit-test surface: this repo has no jsdom/testing-library
 * harness for rendering `'use client'` components with hooks (verified —
 * zero `.test.tsx` files, no `testing-library` dependency; see campfit#96,
 * the standing accepted gap `scheduled-crawls--plan.md`'s Wave 3 task cites
 * for the panel's own interactivity). Every export here is a plain function
 * over plain data — no React import, no hooks — so it can be exercised
 * directly by `tests/integration/schedule-panel-view.test.ts` without that
 * harness.
 */
import type { CrawlSchedulePriority } from '@/lib/admin/schedule-repository';

/** Batch sizes the panel offers — matches the admin route's own server-side
 * `VALID_BATCH_SIZES` ceiling (`app/api/admin/crawl-schedule/route.ts`).
 * Deliberately narrower than `crawl-modal.tsx`'s `LIMIT_OPTIONS`
 * (`[5, 10, 20, 50]`) for manual runs — 20/50 would exceed the serverless
 * batch-size budget documented in the plan for an unattended scheduled run. */
export const BATCH_SIZE_OPTIONS = [5, 10] as const;

/** Cron-automation priority vocabulary only (mirrors
 * `schedule-repository.ts`'s `CrawlSchedulePriority` and the route's
 * `VALID_PRIORITIES`) — copy reused verbatim from `crawl-modal.tsx`'s
 * `PRIORITY_OPTIONS` entries for `'stale'`/`'never_crawled'` so the panel
 * doesn't invent new wording for the same two concepts. */
export const PRIORITY_COPY: Record<CrawlSchedulePriority, { label: string; description: string }> = {
  stale: {
    label: 'Most Stale',
    description: 'Not verified recently, scored by days since last crawl',
  },
  never_crawled: {
    label: 'Never Crawled',
    description: 'Camps that have never been verified by the crawler',
  },
};

export function priorityLabel(priority: CrawlSchedulePriority): string {
  return PRIORITY_COPY[priority]?.label ?? priority;
}

/** Minimal shape the panel needs from a `CrawlRun` row (the route's own
 * `lastRun` field, `app/api/admin/crawl-schedule/route.ts`'s
 * `getLastScheduledRun()` — a subset of `lib/admin/types.ts`'s full
 * `CrawlRun`, not a second/competing type). */
export interface ScheduleLastRun {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  processedCamps: number;
  totalCamps: number;
  errorCount: number;
}

/** Absolute UTC timestamp — matches the schedule route's own UTC-anchored
 * `nextRun` computation (`CRON_HOUR_UTC`), so last-run/next-run readouts use
 * the same timezone convention rather than mixing local + UTC. */
export function formatUtcTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

/** "Last run" readout text — never a second stored copy of `CrawlRun`, just
 * a display-string derived from the route's live-queried `lastRun`. */
export function describeLastRun(lastRun: ScheduleLastRun | null): string {
  if (!lastRun) return 'No scheduled run yet';
  const camps = lastRun.totalCamps > 0
    ? `${lastRun.processedCamps}/${lastRun.totalCamps} camps`
    : 'no camps';
  const errors = lastRun.errorCount > 0
    ? `, ${lastRun.errorCount} error${lastRun.errorCount !== 1 ? 's' : ''}`
    : '';
  return `${lastRun.status} · ${camps}${errors} · ${formatUtcTimestamp(lastRun.startedAt)}`;
}

/** "Next run" readout text — a disabled schedule has no meaningful next run
 * (the route still computes one, but it will never fire), so the panel says
 * so explicitly rather than showing a misleading future date. */
export function describeNextRun(nextRunIso: string, enabled: boolean): string {
  if (!enabled) return 'Scheduling is disabled';
  return `Next run: ${formatUtcTimestamp(nextRunIso)}`;
}
