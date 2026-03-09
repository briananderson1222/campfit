import { getRecentCrawlRuns } from '@/lib/admin/crawl-repository';
import { getPendingCount } from '@/lib/admin/review-repository';
import { getMostChangedFields } from '@/lib/admin/changelog-repository';
import { getDashboardMetrics } from '@/lib/admin/metrics-repository';
import { CrawlModal } from './crawl-modal';
import { ClipboardList, TrendingUp, AlertTriangle, CheckCircle, Activity } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  const [pendingCount, recentRuns, changedFields, metrics] = await Promise.all([
    getPendingCount().catch(() => 0),
    getRecentCrawlRuns(5).catch(() => []),
    getMostChangedFields(30, 5).catch(() => []),
    getDashboardMetrics().catch(() => ({
      approvalRate: 0, avgConfidence: 0, siteFailureRates: [], fieldRejectionRates: []
    })),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Dashboard</h1>
          <p className="text-bark-400 text-sm mt-1">Camp data pipeline overview</p>
        </div>
        <CrawlModal />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Pending Review"
          value={pendingCount}
          icon={<ClipboardList className="w-5 h-5 text-amber-500" />}
          href="/admin/review"
          highlight={pendingCount > 0}
        />
        <StatCard
          label="Approval Rate (30d)"
          value={`${Math.round(metrics.approvalRate * 100)}%`}
          icon={<CheckCircle className="w-5 h-5 text-pine-500" />}
        />
        <StatCard
          label="Avg Confidence (30d)"
          value={`${Math.round(metrics.avgConfidence * 100)}%`}
          icon={<Activity className="w-5 h-5 text-pine-500" />}
        />
        <StatCard
          label="Site Failures (30d)"
          value={metrics.siteFailureRates.filter(s => s.failureRate > 0.5).length}
          icon={<AlertTriangle className="w-5 h-5 text-terracotta-400" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent runs */}
        <div className="glass-panel p-6">
          <h2 className="font-display font-bold text-bark-700 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-pine-400" />
            Recent Crawls
          </h2>
          {recentRuns.length === 0 ? (
            <p className="text-bark-300 text-sm">No crawl runs yet. Start one above.</p>
          ) : (
            <div className="space-y-2">
              {recentRuns.map(run => (
                <Link
                  key={run.id}
                  href={`/admin/crawls?runId=${run.id}`}
                  className="flex items-center justify-between p-3 rounded-xl hover:bg-cream-200/40 transition-colors"
                >
                  <div>
                    <span className={cn(
                      'inline-block px-2 py-0.5 rounded-full text-xs font-semibold mr-2',
                      run.status === 'COMPLETED' ? 'bg-pine-100 text-pine-600' :
                      run.status === 'FAILED' ? 'bg-red-100 text-red-600' :
                      'bg-amber-100 text-amber-600'
                    )}>
                      {run.status}
                    </span>
                    <span className="text-sm text-bark-500">
                      {run.processedCamps}/{run.totalCamps} camps · {run.newProposals} proposals
                    </span>
                  </div>
                  <span className="text-xs text-bark-300">
                    {new Date(run.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </Link>
              ))}
            </div>
          )}
          <Link href="/admin/crawls" className="text-sm text-pine-500 hover:text-pine-600 mt-3 inline-block">
            View all crawls →
          </Link>
        </div>

        {/* Field quality */}
        <div className="glass-panel p-6">
          <h2 className="font-display font-bold text-bark-700 mb-4">Field Rejection Rates (30d)</h2>
          {metrics.fieldRejectionRates.length === 0 ? (
            <p className="text-bark-300 text-sm">No review data yet.</p>
          ) : (
            <div className="space-y-3">
              {metrics.fieldRejectionRates.map(f => (
                <div key={f.field} className="flex items-center gap-3">
                  <span className="text-sm text-bark-500 w-32 shrink-0">{f.field}</span>
                  <div className="flex-1 h-2 bg-cream-300 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all', f.rejectionRate > 0.5 ? 'bg-red-400' : 'bg-pine-400')}
                      style={{ width: `${f.rejectionRate * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-bark-300 w-12 text-right">{Math.round(f.rejectionRate * 100)}%</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-bark-300 mt-4">Fields with high rejection rates need prompt improvements</p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, href, highlight }: {
  label: string; value: string | number; icon: React.ReactNode; href?: string; highlight?: boolean;
}) {
  const content = (
    <div className={cn(
      'glass-panel p-5',
      highlight && 'border-amber-300/60 bg-amber-50/30'
    )}>
      <div className="flex items-center justify-between mb-2">
        {icon}
        <span className="text-xs text-bark-300 uppercase tracking-wide">{label}</span>
      </div>
      <p className="font-display text-3xl font-extrabold text-bark-700">{value}</p>
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}
