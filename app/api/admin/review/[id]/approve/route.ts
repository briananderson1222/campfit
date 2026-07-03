import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunitySlug } from '@/lib/admin/community-access';
import {
  applyProposalReview,
  ReviewApplyConflictError,
  ReviewApplyProposalNotFoundError,
  ReviewApplySessionNotFoundError,
  SurveyReviewApplyError,
  SurveyReviewSessionStaleError,
} from '@/lib/admin/review-apply';

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const communitySlug = await getProposalCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { reviewSessionId, reviewerNotes, feedbackTags, keepPending = false }: {
    reviewSessionId?: string;
    reviewerNotes?: string;
    feedbackTags?: string[];
    keepPending?: boolean;
  } = await request.json();

  if (!reviewSessionId || typeof reviewSessionId !== 'string') {
    return NextResponse.json({ error: 'Review apply requires a server-created reviewSessionId.' }, { status: 400 });
  }

  try {
    const result = await applyProposalReview({
      proposalId: params.id,
      reviewSessionId,
      reviewer: auth.access.email,
      notes: reviewerNotes,
      feedbackTags,
      keepPending,
    });

    return NextResponse.json({
      success: true,
      kept: result.kept,
      appliedFields: result.appliedFields.length,
      ...(result.provenanceErrors.length ? { provenanceErrors: result.provenanceErrors } : {}),
    });
  } catch (error) {
    if (error instanceof ReviewApplyProposalNotFoundError || error instanceof ReviewApplySessionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof SurveyReviewSessionStaleError || error instanceof ReviewApplyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SurveyReviewApplyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Approve error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
