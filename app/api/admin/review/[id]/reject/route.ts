import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProposal, updateProposalStatus } from '@/lib/admin/review-repository';
import { recordReviewDecision } from '@/lib/admin/metrics-repository';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { reviewerNotes, feedbackTags }: {
    reviewerNotes?: string;
    feedbackTags?: string[];
  } = await request.json();

  const proposal = await getProposal(params.id);
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Already reviewed' }, { status: 409 });

  await updateProposalStatus(params.id, 'REJECTED', user.email, reviewerNotes, feedbackTags);
  await recordReviewDecision({
    proposalId: params.id,
    runId: proposal.crawlRunId,
    approvedFields: [],
    rejectedFields: Object.keys(proposal.proposedChanges),
  });

  return NextResponse.json({ success: true });
}
