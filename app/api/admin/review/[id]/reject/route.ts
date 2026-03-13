import { NextResponse } from 'next/server';
import { getProposal, updateProposalStatus } from '@/lib/admin/review-repository';
import { recordReviewDecision } from '@/lib/admin/metrics-repository';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunitySlug } from '@/lib/admin/community-access';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const communitySlug = await getProposalCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { reviewerNotes, feedbackTags }: {
    reviewerNotes?: string;
    feedbackTags?: string[];
  } = await request.json();

  const proposal = await getProposal(params.id);
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Already reviewed' }, { status: 409 });

  await updateProposalStatus(params.id, 'REJECTED', auth.access.email, reviewerNotes, feedbackTags);
  await recordReviewDecision({
    proposalId: params.id,
    runId: proposal.crawlRunId,
    approvedFields: [],
    rejectedFields: Object.keys(proposal.proposedChanges),
  });

  return NextResponse.json({ success: true });
}
