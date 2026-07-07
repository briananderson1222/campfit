import type { UnassignedSourceFailureRow } from '@/lib/admin/crawl-failure-repository';

/**
 * Minimal "Unassigned source failures" section (campfit#85 code-review
 * finding M3): display-only surface for `getUnassignedSourceFailures()` —
 * sources-strategy `errorLog` entries recorded BEFORE any `Camp` row could
 * be resolved/anchored (`source:<sourceKey>`, never a real `Camp.id` — see
 * `crawl-failure-repository.ts`'s file doc and `crawl-pipeline.ts`'s
 * `sourceFailureCampId`). These were previously visible only via a direct
 * query (`getUncrawlableCamps`'s `JOIN "Camp"` intentionally excludes them),
 * so an operator looking at only the table above never saw them — this
 * section closes that operator-visibility gap.
 *
 * No per-row actions (retry / fix URL / add hint) apply here — unlike
 * `CrawlFailuresTable`'s rows, there is no `Camp` row yet to act on. This
 * slice is display + count only; wiring an action (e.g. "create a camp from
 * this source failure") is left for a future slice if it's ever needed.
 */
export function UnassignedSourceFailuresTable({ rows }: { rows: UnassignedSourceFailureRow[] }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold text-bark-700">Unassigned Source Failures</h2>
        <p className="mt-1 text-sm text-bark-400">
          Sweep-source failures recorded before any camp could be anchored — no camp record exists yet
          for these, so no per-row actions apply here.
        </p>
        <p className="mt-1 text-xs text-bark-400">
          {rows.length} unassigned source failure{rows.length === 1 ? '' : 's'} in the last 45 days
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.sourceKey} className="glass-panel p-5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-bark-700">{row.sourceKey}</span>
              <span className="rounded-full bg-cream-200 px-2 py-0.5 text-[11px] font-semibold text-bark-500">
                {row.failureCount} failures
              </span>
            </div>
            <p className="text-xs text-bark-400">
              latest failure{' '}
              {new Date(row.latestStartedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {row.latestError}
            </div>
            {row.latestUrl && (
              <a href={row.latestUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-pine-600 underline">
                {row.latestUrl}
              </a>
            )}
          </div>
        ))}

        {rows.length === 0 && (
          <div className="glass-panel p-8 text-center text-bark-300">
            No unassigned source failures in the last 45 days.
          </div>
        )}
      </div>
    </div>
  );
}
