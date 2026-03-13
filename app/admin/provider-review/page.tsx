import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { requireAdminAccess } from '@/lib/admin/access';
import { getPendingProviderProposals } from '@/lib/admin/provider-repository';

export const dynamic = 'force-dynamic';

function buildQueueHref(params: { page?: number | string; providerId?: string }) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.providerId) qs.set('providerId', params.providerId);
  return `/admin/provider-review${qs.toString() ? `?${qs.toString()}` : ''}`;
}

function buildDetailHref(id: string, params: { page?: number | string; providerId?: string }) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.providerId) qs.set('providerId', params.providerId);
  return `/admin/provider-review/${id}${qs.toString() ? `?${qs.toString()}` : ''}`;
}

export default async function ProviderReviewQueuePage({
  searchParams,
}: {
  searchParams: { page?: string; providerId?: string };
}) {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;

  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10));
  const providerId = searchParams.providerId || undefined;
  const limit = 25;
  const offset = (page - 1) * limit;
  const { proposals, total } = await getPendingProviderProposals({
    limit,
    offset,
    providerId,
    communitySlugs: auth.access.isAdmin ? undefined : auth.access.communities,
  }).catch(() => ({ proposals: [], total: 0 }));
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Provider Review</h1>
          <p className="text-bark-400 text-sm mt-1">
            {total} pending provider proposal{total !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {providerId && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-bark-300 uppercase tracking-wide">Active filter</span>
          <span className="inline-flex items-center rounded-full bg-pine-100 px-2.5 py-1 text-xs font-semibold text-pine-700">
            Provider: {providerId}
          </span>
          <Link href="/admin/provider-review" className="text-xs text-bark-400 hover:text-pine-600">
            Clear filter
          </Link>
        </div>
      )}

      {proposals.length === 0 ? (
        <div className="glass-panel p-16 text-center">
          <p className="text-bark-300 text-lg">No pending provider proposals</p>
          <p className="text-bark-200 text-sm mt-2">Assistant and trust tools can still propose provider edits.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {proposals.map((proposal) => {
            const changeCount = Object.keys(proposal.proposedChanges ?? {}).length;
            const conf = Math.round((proposal.overallConfidence ?? 0) * 100);
            return (
              <Link
                key={proposal.id}
                href={buildDetailHref(proposal.id, { page, providerId })}
                className="glass-panel p-5 flex items-center gap-4 hover:border-pine-300/60 transition-colors group"
              >
                <div className={cn(
                  'w-14 h-14 rounded-2xl flex flex-col items-center justify-center shrink-0 text-white font-bold',
                  conf >= 80 ? 'bg-pine-500' : conf >= 50 ? 'bg-amber-400' : 'bg-red-400'
                )}>
                  <span className="text-lg leading-none">{conf}</span>
                  <span className="text-[10px] leading-none opacity-80">%</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-bark-700 group-hover:text-pine-600 transition-colors truncate">
                      {proposal.providerName}
                    </h3>
                    <span className="text-xs text-bark-300 shrink-0">{proposal.communitySlug}</span>
                  </div>
                  <p className="text-xs text-bark-400 mb-2">
                    {changeCount} field{changeCount !== 1 ? 's' : ''} changed ·{' '}
                    {new Date(proposal.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.keys(proposal.proposedChanges ?? {}).slice(0, 5).map((field) => (
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
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {page > 1 && (
            <Link href={buildQueueHref({ page: page - 1, providerId })} className="btn-secondary text-sm">Previous</Link>
          )}
          <span className="px-4 py-2 text-sm text-bark-400">Page {page} of {totalPages}</span>
          {page < totalPages && (
            <Link href={buildQueueHref({ page: page + 1, providerId })} className="btn-secondary text-sm">Next</Link>
          )}
        </div>
      )}
    </div>
  );
}
