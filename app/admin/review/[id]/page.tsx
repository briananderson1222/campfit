import { notFound } from 'next/navigation';
import { getProposal } from '@/lib/admin/review-repository';
import { ReviewPanel } from './review-panel';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function ReviewDetailPage({ params }: { params: { id: string } }) {
  const proposal = await getProposal(params.id);
  if (!proposal) notFound();

  return (
    <div>
      <Link href="/admin/review" className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500 mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to queue
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-bark-700">{proposal.campName}</h1>
          <a href={proposal.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-pine-500 hover:text-pine-600 mt-1 inline-block">
            {proposal.sourceUrl.replace(/^https?:\/\//, '')} ↗
          </a>
        </div>
        <div className="text-right">
          <p className="text-sm text-bark-400">Overall confidence</p>
          <p className="font-display text-3xl font-bold text-bark-700">{Math.round(proposal.overallConfidence * 100)}%</p>
        </div>
      </div>

      <ReviewPanel proposal={proposal} />
    </div>
  );
}
