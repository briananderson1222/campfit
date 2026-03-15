import { notFound } from 'next/navigation';
import { getPendingProposalQueue, getProposal } from '@/lib/admin/review-repository';
import { ReviewPanel } from './review-panel';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { requireAdminAccess } from '@/lib/admin/access';
import { AdminCopilot } from '@/components/admin/admin-copilot';

export const dynamic = 'force-dynamic';

function buildQueueHref(searchParams: { campId?: string; providerId?: string; page?: string }) {
  const qs = new URLSearchParams();
  if (searchParams.campId) qs.set('campId', searchParams.campId);
  if (searchParams.providerId) qs.set('providerId', searchParams.providerId);
  if (searchParams.page) qs.set('page', searchParams.page);
  return `/admin/review${qs.toString() ? `?${qs.toString()}` : ''}`;
}

function buildDetailHref(id: string, searchParams: { campId?: string; providerId?: string; page?: string }) {
  const qs = new URLSearchParams();
  if (searchParams.campId) qs.set('campId', searchParams.campId);
  if (searchParams.providerId) qs.set('providerId', searchParams.providerId);
  if (searchParams.page) qs.set('page', searchParams.page);
  return `/admin/review/${id}${qs.toString() ? `?${qs.toString()}` : ''}`;
}

export default async function ReviewDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { campId?: string; providerId?: string; page?: string };
}) {
  const proposal = await getProposal(params.id);
  if (!proposal) notFound();
  const auth = await requireAdminAccess({ communitySlug: proposal.communitySlug, allowModerator: true });
  if ('error' in auth) notFound();

  const queue = await getPendingProposalQueue({
    currentId: params.id,
    campId: searchParams.campId,
    providerId: searchParams.providerId,
    communitySlugs: auth.access.isAdmin ? undefined : auth.access.communities,
  });
  const backHref = buildQueueHref(searchParams);
  const campHref = `/admin/camps/${proposal.campId}`;
  const providerHref = proposal.providerId ? `/admin/providers/${proposal.providerId}` : null;

  return (
    <div>
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500 mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to queue
      </Link>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-bark-700">{proposal.campName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
            <a href={proposal.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-pine-500 hover:text-pine-600">
              {proposal.sourceUrl.replace(/^https?:\/\//, '')}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <Link href={campHref} className="inline-flex items-center gap-1 text-bark-400 hover:text-pine-600">
              View camp data
            </Link>
            {providerHref && (
              <Link href={providerHref} className="inline-flex items-center gap-1 text-bark-400 hover:text-pine-600">
                View provider
              </Link>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm text-bark-400">Overall confidence</p>
          <p className="font-display text-3xl font-bold text-bark-700">{Math.round(proposal.overallConfidence * 100)}%</p>
          {proposal.crawlCompletedAt && (
            <p className="mt-1 text-xs text-bark-400">
              Last crawled {new Date(proposal.crawlCompletedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          )}
        </div>
      </div>

      <div className="mb-4 flex items-center justify-end gap-2">
        {queue.previousId && (
          <Link href={buildDetailHref(queue.previousId, searchParams)} className="btn-secondary gap-1.5 text-sm">
            <ChevronLeft className="w-4 h-4" />
            Previous
          </Link>
        )}
        {queue.nextId && (
          <Link href={buildDetailHref(queue.nextId, searchParams)} className="btn-secondary gap-1.5 text-sm">
            Next
            <ChevronRight className="w-4 h-4" />
          </Link>
        )}
      </div>

      <ReviewPanel
        proposal={proposal}
        queueContext={{
          backHref,
          campHref,
          providerHref,
          nextHref: queue.nextId ? buildDetailHref(queue.nextId, searchParams) : null,
          previousHref: queue.previousId ? buildDetailHref(queue.previousId, searchParams) : null,
        }}
      />

      <AdminCopilot entityType="CAMP" entityId={proposal.campId} />
    </div>
  );
}
