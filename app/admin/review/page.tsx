import Link from 'next/link';
import { getPendingProposals, getUnverifiedCamps, getPendingReports } from '@/lib/admin/review-repository';
import { cn } from '@/lib/utils';
import { ChevronRight, AlertTriangle, Clock, Flag } from 'lucide-react';
import { ReportActions } from './report-actions';
import { requireAdminAccess } from '@/lib/admin/access';

export const dynamic = 'force-dynamic';

const REPORT_TYPE_LABELS: Record<string, string> = {
  WRONG_INFO: 'Wrong info',
  MISSING_INFO: 'Missing info',
  CAMP_CLOSED: 'Camp closed',
  OTHER: 'Other',
};

const REPORT_TYPE_COLORS: Record<string, string> = {
  WRONG_INFO: 'bg-red-100 text-red-600',
  MISSING_INFO: 'bg-amber-100 text-amber-700',
  CAMP_CLOSED: 'bg-bark-100 text-bark-600',
  OTHER: 'bg-cream-200 text-bark-500',
};

function buildReviewHref(params: {
  tab?: string;
  page?: number | string;
  campId?: string;
  providerId?: string;
}) {
  const qs = new URLSearchParams();
  if (params.tab) qs.set('tab', params.tab);
  if (params.page) qs.set('page', String(params.page));
  if (params.campId) qs.set('campId', params.campId);
  if (params.providerId) qs.set('providerId', params.providerId);
  return `/admin/review?${qs.toString()}`;
}

function buildDetailHref(proposalId: string, params: {
  page?: number | string;
  campId?: string;
  providerId?: string;
}) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.campId) qs.set('campId', params.campId);
  if (params.providerId) qs.set('providerId', params.providerId);
  return `/admin/review/${proposalId}${qs.toString() ? `?${qs.toString()}` : ''}`;
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: { page?: string; tab?: string; campId?: string; providerId?: string };
}) {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;
  const tab = searchParams.tab === 'unverified' ? 'unverified'
    : searchParams.tab === 'reports' ? 'reports'
    : 'proposals';
  const page = Math.max(1, parseInt(searchParams.page ?? '1'));
  const campId = searchParams.campId || undefined;
  const providerId = searchParams.providerId || undefined;
  const limit = 25;
  const offset = (page - 1) * limit;

  const [{ proposals, total: proposalTotal }, { camps: unverifiedCamps, total: unverifiedTotal }, { reports, total: reportTotal }] =
    await Promise.all([
      getPendingProposals({
        limit,
        offset,
        campId,
        providerId,
        communitySlugs: auth.access.isAdmin ? undefined : auth.access.communities,
      }).catch(() => ({ proposals: [], total: 0 })),
      getUnverifiedCamps({
        limit,
        offset,
        communitySlugs: auth.access.isAdmin ? undefined : auth.access.communities,
      }).catch(() => ({ camps: [], total: 0 })),
      getPendingReports({
        limit,
        offset,
        communitySlugs: auth.access.isAdmin ? undefined : auth.access.communities,
      }).catch(() => ({ reports: [], total: 0 })),
    ]);

  const activeTotal = tab === 'unverified' ? unverifiedTotal
    : tab === 'reports' ? reportTotal
    : proposalTotal;
  const totalPages = Math.ceil(activeTotal / limit);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Review Queue</h1>
          <p className="text-bark-400 text-sm mt-1">
            {proposalTotal} pending proposal{proposalTotal !== 1 ? 's' : ''} ·{' '}
            {unverifiedTotal} unverified camp{unverifiedTotal !== 1 ? 's' : ''} ·{' '}
            {reportTotal} user report{reportTotal !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {(campId || providerId) && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-bark-300 uppercase tracking-wide">Active filters</span>
          {campId && (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
              Camp: {campId}
            </span>
          )}
          {providerId && (
            <span className="inline-flex items-center rounded-full bg-pine-100 px-2.5 py-1 text-xs font-semibold text-pine-700">
              Provider: {providerId}
            </span>
          )}
          <Link href="/admin/review" className="text-xs text-bark-400 hover:text-pine-600">
            Clear filters
          </Link>
        </div>
      )}

      <div className="flex gap-1 mb-5 border-b border-cream-300/60">
        <TabLink href={buildReviewHref({ tab: 'proposals', page: 1, campId, providerId })} active={tab === 'proposals'}>
          Pending Proposals
          {proposalTotal > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-amber-400 text-white text-[10px] font-bold leading-none">
              {proposalTotal}
            </span>
          )}
        </TabLink>
        <TabLink href={buildReviewHref({ tab: 'unverified', page: 1, campId, providerId })} active={tab === 'unverified'}>
          Unverified Camps
          {unverifiedTotal > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-red-400 text-white text-[10px] font-bold leading-none">
              {unverifiedTotal}
            </span>
          )}
        </TabLink>
        <TabLink href={buildReviewHref({ tab: 'reports', page: 1, campId, providerId })} active={tab === 'reports'}>
          User Reports
          {reportTotal > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none">
              {reportTotal}
            </span>
          )}
        </TabLink>
      </div>

      {tab === 'proposals' && (
        proposals.length === 0 ? (
          <div className="glass-panel p-16 text-center">
            <p className="text-bark-300 text-lg">No pending proposals</p>
            <p className="text-bark-200 text-sm mt-2">Run a crawl to generate proposals for review</p>
          </div>
        ) : (
          <div className="space-y-3">
            {proposals.map(proposal => {
              const changeCount = Object.keys(proposal.proposedChanges).length;
              const conf = proposal.overallConfidence;
              return (
                <Link
                  key={proposal.id}
                  href={buildDetailHref(proposal.id, { page, campId, providerId })}
                  className="glass-panel p-5 flex items-center gap-4 hover:border-pine-300/60 transition-colors group"
                >
                  <ConfidenceBadge value={conf} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-bark-700 group-hover:text-pine-600 transition-colors truncate">
                        {proposal.campName}
                      </h3>
                      <span className="text-xs text-bark-300 shrink-0">{proposal.communitySlug}</span>
                    </div>
                    <p className="text-xs text-bark-400 mb-2">
                      {changeCount} field{changeCount !== 1 ? 's' : ''} changed
                      {proposal.crawlCompletedAt && (
                        <span> · Crawled {new Date(proposal.crawlCompletedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                      )}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.keys(proposal.proposedChanges).slice(0, 5).map(field => (
                        <span key={field} className="px-2 py-0.5 rounded-full bg-cream-100 text-bark-500 text-xs">
                          {field}
                        </span>
                      ))}
                      {changeCount > 5 && (
                        <span className="text-xs text-bark-300">+{changeCount - 5} more</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-bark-300 shrink-0 group-hover:text-pine-500 transition-colors" />
                </Link>
              );
            })}
          </div>
        )
      )}

      {tab === 'unverified' && (
        unverifiedCamps.length === 0 ? (
          <div className="glass-panel p-16 text-center">
            <p className="text-bark-300 text-lg">All camps are verified!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {unverifiedCamps.map(camp => (
              <Link
                key={camp.id}
                href={`/admin/camps/${camp.id}`}
                className="glass-panel px-5 py-3.5 flex items-center gap-4 hover:border-pine-300/60 transition-colors group"
              >
                <ConfidencePill confidence={camp.dataConfidence} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-bark-700 group-hover:text-pine-600 transition-colors truncate">
                    {camp.name}
                  </p>
                  <p className="text-xs text-bark-400 mt-0.5 flex items-center gap-2">
                    <span>{camp.communitySlug}</span>
                    {camp.lastVerifiedAt ? (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Last verified {new Date(camp.lastVerifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-amber-500">
                        <AlertTriangle className="w-3 h-3" />
                        Never verified
                      </span>
                    )}
                    {!camp.websiteUrl && (
                      <span className="text-red-400">No website URL</span>
                    )}
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-bark-300 shrink-0 group-hover:text-pine-500 transition-colors" />
              </Link>
            ))}
          </div>
        )
      )}

      {tab === 'reports' && (
        reports.length === 0 ? (
          <div className="glass-panel p-16 text-center">
            <Flag className="w-8 h-8 text-bark-200 mx-auto mb-3" />
            <p className="text-bark-300 text-lg">No pending reports</p>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map(report => (
              <div key={report.id} className="glass-panel p-5 flex items-start gap-4">
                <div className={cn(
                  'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                  REPORT_TYPE_COLORS[report.type] ?? 'bg-cream-200 text-bark-400'
                )}>
                  <Flag className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/admin/camps/${report.campId}`} className="font-semibold text-bark-700 hover:text-pine-600 transition-colors">
                      {report.campName}
                    </Link>
                    <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full', REPORT_TYPE_COLORS[report.type])}>
                      {REPORT_TYPE_LABELS[report.type] ?? report.type}
                    </span>
                  </div>
                  <p className="text-sm text-bark-500 mt-1.5 leading-relaxed">{report.description}</p>
                  <p className="text-xs text-bark-300 mt-2">
                    {report.userEmail ?? 'Anonymous'} ·{' '}
                    {new Date(report.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                  </p>
                </div>
                <ReportActions reportId={report.id} campId={report.campId} campSlug={report.campSlug} communitySlug={report.communitySlug} />
              </div>
            ))}
          </div>
        )
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {page > 1 && (
            <Link href={buildReviewHref({ tab, page: page - 1, campId, providerId })} className="btn-secondary text-sm">Previous</Link>
          )}
          <span className="px-4 py-2 text-sm text-bark-400">Page {page} of {totalPages}</span>
          {page < totalPages && (
            <Link href={buildReviewHref({ tab, page: page + 1, campId, providerId })} className="btn-secondary text-sm">Next</Link>
          )}
        </div>
      )}
    </div>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-4 py-2.5 text-sm font-medium flex items-center border-b-2 -mb-px transition-colors',
        active
          ? 'border-pine-500 text-pine-600'
          : 'border-transparent text-bark-400 hover:text-bark-600 hover:border-bark-300'
      )}
    >
      {children}
    </Link>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className={cn(
      'w-14 h-14 rounded-2xl flex flex-col items-center justify-center shrink-0 text-white font-bold',
      pct >= 80 ? 'bg-pine-500' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
    )}>
      <span className="text-lg leading-none">{pct}</span>
      <span className="text-[10px] leading-none opacity-80">%</span>
    </div>
  );
}

function ConfidencePill({ confidence }: { confidence: string }) {
  const color = confidence === 'VERIFIED'
    ? 'bg-pine-100 text-pine-700'
    : confidence === 'STALE'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-red-100 text-red-600';

  return (
    <span className={cn('px-2 py-1 rounded-full text-xs font-semibold shrink-0', color)}>
      {confidence}
    </span>
  );
}
