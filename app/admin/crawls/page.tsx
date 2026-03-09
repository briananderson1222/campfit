import { getPool } from '@/lib/db';
import type { CrawlRun } from '@/lib/admin/types';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

async function getRecentRuns(): Promise<CrawlRun[]> {
  const pool = getPool();
  const result = await pool.query<CrawlRun>(
    `SELECT * FROM "CrawlRun" ORDER BY "startedAt" DESC LIMIT 50`
  );
  return result.rows;
}

function durationLabel(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return 'In progress';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

export default async function AdminCrawlsPage({
  searchParams,
}: {
  searchParams: { runId?: string };
}) {
  const runs = await getRecentRuns().catch(() => [] as CrawlRun[]);
  const highlightId = searchParams.runId;

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-extrabold text-bark-700">Crawl History</h1>
        <p className="text-bark-400 text-sm mt-1">Last 50 crawl runs</p>
      </div>

      {runs.length === 0 ? (
        <div className="glass-panel p-16 text-center">
          <p className="text-bark-300 text-lg">No crawl runs yet</p>
          <p className="text-bark-200 text-sm mt-2">Start a crawl from the dashboard to see results here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map(run => {
            const isHighlighted = run.id === highlightId;
            const errorLog = Array.isArray(run.errorLog) ? run.errorLog : [];

            return (
              <div
                key={run.id}
                id={run.id}
                className={cn(
                  'glass-panel p-5 transition-colors',
                  isHighlighted && 'border-pine-300/60 bg-pine-50/20'
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <StatusBadge status={run.status} />
                    <span className="text-sm text-bark-500">
                      {run.processedCamps}/{run.totalCamps} camps
                    </span>
                    <span className="text-xs text-bark-300">·</span>
                    <span className="text-sm text-bark-500">
                      {run.newProposals} proposals
                    </span>
                    {run.errorCount > 0 && (
                      <>
                        <span className="text-xs text-bark-300">·</span>
                        <span className="text-sm text-red-500">{run.errorCount} errors</span>
                      </>
                    )}
                    <span className="text-xs text-bark-300">·</span>
                    <span className="text-xs text-bark-300">{durationLabel(run.startedAt, run.completedAt)}</span>
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-sm text-bark-500">
                      {new Date(run.startedAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                    <p className="text-xs text-bark-300 mt-0.5">
                      {run.trigger} · {run.triggeredBy ?? 'system'}
                    </p>
                  </div>
                </div>

                {/* Error log — shown if highlighted or if run failed */}
                {(isHighlighted || run.status === 'FAILED') && errorLog.length > 0 && (
                  <div className="mt-4 border-t border-cream-300/50 pt-4">
                    <p className="text-xs font-semibold text-red-500 mb-2 uppercase tracking-wide">
                      Error Log ({errorLog.length})
                    </p>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {errorLog.map((entry, i) => (
                        <div key={i} className="text-xs rounded-lg bg-red-50 border border-red-100 p-2">
                          <p className="font-medium text-red-700 truncate">
                            <a href={entry.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                              {entry.url}
                            </a>
                          </p>
                          <p className="text-red-500 mt-0.5">{entry.error}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Camp IDs filter indicator */}
                {run.campIds && run.campIds.length > 0 && (
                  <p className="text-xs text-bark-300 mt-2">
                    Filtered to {run.campIds.length} camp{run.campIds.length !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    COMPLETED: 'bg-pine-100 text-pine-700',
    FAILED: 'bg-red-100 text-red-600',
    RUNNING: 'bg-amber-100 text-amber-700',
  };
  return (
    <span className={cn(
      'inline-block px-2 py-0.5 rounded-full text-xs font-semibold',
      styles[status] ?? 'bg-cream-200 text-bark-400'
    )}>
      {status}
    </span>
  );
}
