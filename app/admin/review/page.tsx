import Link from 'next/link';
import { getPendingProposals } from '@/lib/admin/review-repository';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: { page?: string; minConfidence?: string };
}) {
  const page = Math.max(1, parseInt(searchParams.page ?? '1'));
  const minConfidence = parseFloat(searchParams.minConfidence ?? '0');
  const limit = 20;
  const offset = (page - 1) * limit;

  const { proposals, total } = await getPendingProposals({ limit, offset, minConfidence }).catch(() => ({ proposals: [], total: 0 }));
  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Review Queue</h1>
          <p className="text-bark-400 text-sm mt-1">{total} pending proposals</p>
        </div>
      </div>

      {proposals.length === 0 ? (
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
                href={`/admin/review/${proposal.id}`}
                className="glass-panel p-5 flex items-center gap-4 hover:border-pine-300/60 transition-colors group"
              >
                <ConfidenceBadge value={conf} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-bark-700 group-hover:text-pine-600 transition-colors">
                    {proposal.campName}
                  </p>
                  <p className="text-sm text-bark-400 mt-0.5">
                    {changeCount} field{changeCount !== 1 ? 's' : ''} changed ·{' '}
                    {new Date(proposal.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {proposal.crawlStartedAt && (
                      <span className="text-bark-300"> · crawl {new Date(proposal.crawlStartedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {Object.keys(proposal.proposedChanges).slice(0, 5).map(field => (
                      <span key={field} className="text-xs bg-cream-200 text-bark-400 px-2 py-0.5 rounded-full">
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
            <Link href={`/admin/review?page=${page - 1}`} className="btn-secondary text-sm">Previous</Link>
          )}
          <span className="px-4 py-2 text-sm text-bark-400">Page {page} of {totalPages}</span>
          {page < totalPages && (
            <Link href={`/admin/review?page=${page + 1}`} className="btn-secondary text-sm">Next</Link>
          )}
        </div>
      )}
    </div>
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
