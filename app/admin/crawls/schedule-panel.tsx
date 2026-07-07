'use client';

/**
 * app/admin/crawls/schedule-panel.tsx — schedule controls panel mounted on
 * `/admin/crawls` (campfit#92 AC2/AC4, Wave 3).
 *
 * A small, self-contained `'use client'` island — the same shape
 * `AdminCrawlsPage` itself already uses for its own runs list (fetch on
 * mount via `useEffect`, `setState` from the JSON response — no server
 * component wraps this panel, since `app/admin/crawls/page.tsx` is already a
 * client component end-to-end, not a server component + client-island split
 * like `app/admin/camps/page.tsx`/`camps-table.tsx`). Calls the Wave 2
 * `GET`/`PATCH /api/admin/crawl-schedule` routes; follows
 * `crawl-modal.tsx`'s existing fetch-and-`setState` error-handling shape
 * (`try/catch` + a plain error string, no new error-UI pattern) for the
 * `PATCH` path, and `first-crawl-offer.tsx`'s `state === 'error'` +
 * "Try again" idiom (`app/admin/providers/[providerId]/first-crawl-offer.tsx`)
 * for the initial-load GET, since that path needs its own distinct
 * loading/ready/error states rather than a plain error string layered under
 * a permanent loading spinner.
 *
 * Formatting/copy logic lives in `./schedule-panel-view.ts` (pure functions,
 * no React) so it has a real unit-test surface — this component's own
 * interactivity is the standing campfit#96 accepted gap (no jsdom/
 * testing-library harness exists in this repo to render it; see that file's
 * header doc and the plan's Wave 3 task for the same note already accepted
 * for `crawl-runner-button.tsx`'s transport migration). The initial-load
 * GET's response classification (ok/non-ok/network-reject) is ALSO extracted
 * there (`classifyScheduleLoad`) specifically so that logic has its own
 * direct unit test — campfit#92 code review's HIGH finding: this file
 * previously passed a non-2xx error-shaped body (e.g. `403
 * { error: 'Forbidden' }`) straight to `setState`, which then crashed on
 * `schedule.enabled`/`schedule.priority` being read off `undefined`; and a
 * network-level `fetch` rejection set an `error` string that was
 * unreachable dead code, since the render's `if (!state) return <Loading/>`
 * ran first for that path unconditionally.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock, AlertTriangle, ToggleLeft, ToggleRight, Loader2, XCircle } from 'lucide-react';
import type { CrawlSchedule, CrawlSchedulePriority } from '@/lib/admin/schedule-repository';
import {
  BATCH_SIZE_OPTIONS,
  PRIORITY_COPY,
  priorityLabel,
  describeLastRun,
  describeNextRun,
  classifyScheduleLoad,
  type ScheduleResponse,
} from './schedule-panel-view';

const PRIORITY_ICONS: Record<CrawlSchedulePriority, React.ReactNode> = {
  stale: <Clock className="w-4 h-4" />,
  never_crawled: <AlertTriangle className="w-4 h-4" />,
};

type SchedulePatch = Partial<Pick<CrawlSchedule, 'enabled' | 'priority' | 'batchSize'>>;

/** The panel's own initial-load state — distinct from `'loading'` so a
 * failed GET renders a "failed to load" message with a retry affordance
 * instead of either crashing (a non-ok response's body treated as data) or
 * spinning forever (a network rejection with nowhere to render its error). */
type PanelState =
  | { status: 'loading' }
  | { status: 'ready'; data: ScheduleResponse }
  | { status: 'error'; message: string };

export function SchedulePanel() {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);

  const loadSchedule = useCallback(() => {
    let cancelled = false;
    setPanelState({ status: 'loading' });
    fetch('/api/admin/crawl-schedule')
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        return classifyScheduleLoad(r.ok ? { kind: 'ok', body } : { kind: 'http-error', status: r.status, body });
      })
      .catch(() => classifyScheduleLoad({ kind: 'network-error' }))
      .then((result) => {
        if (cancelled) return;
        setPanelState(
          result.status === 'ready'
            ? { status: 'ready', data: result.data }
            : { status: 'error', message: result.message }
        );
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => loadSchedule(), [loadSchedule]);

  async function patch(body: SchedulePatch) {
    setSaving(true);
    setPatchError(null);
    try {
      const res = await fetch('/api/admin/crawl-schedule', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPatchError(data?.error ?? 'Failed to update schedule');
        return;
      }
      setPanelState({ status: 'ready', data });
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : 'Error updating schedule');
    } finally {
      setSaving(false);
    }
  }

  if (panelState.status === 'loading') {
    return (
      <div className="glass-panel p-4 mb-4 flex items-center gap-2 text-bark-300 text-sm">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading schedule…
      </div>
    );
  }

  if (panelState.status === 'error') {
    return (
      <div className="glass-panel p-4 mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <XCircle className="w-5 h-5 text-red-400 shrink-0" />
          <p className="text-sm text-red-500">{panelState.message}</p>
        </div>
        <button onClick={loadSchedule} className="btn-secondary text-sm">
          Try again
        </button>
      </div>
    );
  }

  const { schedule, lastRun, nextRun } = panelState.data;

  return (
    <div className="glass-panel p-4 sm:p-5 mb-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-bark-700">Scheduled Crawl</h2>
          <p className="text-xs text-bark-300 mt-0.5">Runs a bounded batch automatically once a day</p>
        </div>
        <button
          onClick={() => patch({ enabled: !schedule.enabled })}
          disabled={saving}
          title={schedule.enabled ? 'Disable scheduled crawl' : 'Enable scheduled crawl'}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-bark-600 disabled:opacity-50"
        >
          {schedule.enabled
            ? <ToggleRight className="w-5 h-5 text-pine-500" />
            : <ToggleLeft className="w-5 h-5 text-bark-300" />}
          {schedule.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="text-xs font-medium text-bark-400 flex flex-col gap-1">
          Priority
          <select
            value={schedule.priority}
            disabled={saving}
            onChange={(e) => patch({ priority: e.target.value as CrawlSchedulePriority })}
            className="rounded-lg border border-cream-300/60 bg-cream-50/60 px-2 py-1.5 text-sm text-bark-700 disabled:opacity-50"
          >
            {(Object.keys(PRIORITY_COPY) as CrawlSchedulePriority[]).map((p) => (
              <option key={p} value={p}>{priorityLabel(p)}</option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-bark-400 flex flex-col gap-1">
          Batch size
          <select
            value={schedule.batchSize}
            disabled={saving}
            onChange={(e) => patch({ batchSize: Number(e.target.value) })}
            className="rounded-lg border border-cream-300/60 bg-cream-50/60 px-2 py-1.5 text-sm text-bark-700 disabled:opacity-50"
          >
            {BATCH_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n} camps</option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1.5 text-xs text-bark-300 self-end pb-1.5">
          {PRIORITY_ICONS[schedule.priority]}
          <span>{PRIORITY_COPY[schedule.priority]?.description}</span>
        </div>
      </div>

      <div className="text-xs text-bark-300 space-y-1 pt-1 border-t border-cream-200/40">
        <p className="pt-1.5">
          Last run:{' '}
          {lastRun
            ? <Link href={`/admin/crawls?runId=${lastRun.id}`} className="text-pine-500 hover:text-pine-600 font-medium">
                {describeLastRun(lastRun)}
              </Link>
            : describeLastRun(null)}
        </p>
        <p>{describeNextRun(nextRun, schedule.enabled)}</p>
      </div>

      {patchError && (
        <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded px-2 py-1">{patchError}</p>
      )}
    </div>
  );
}
