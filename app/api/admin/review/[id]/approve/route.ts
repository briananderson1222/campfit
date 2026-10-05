import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunitySlug } from '@/lib/admin/community-access';
import {
  applyProposalReview,
  ReviewApplyCitationError,
  ReviewApplyConflictError,
  ReviewApplyEvidenceError,
  ReviewApplyProposalNotFoundError,
  ReviewApplyValueError,
  ReviewCitationMismatchError,
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
      ...(result.verification ? { verification: result.verification } : {}),
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
    // A reviewer-fixable refusal: the request was understood, but an approved
    // field's citation or value cannot be accepted. Nothing was written.
    if (
      error instanceof ReviewApplyCitationError
      || error instanceof ReviewApplyValueError
      || error instanceof ReviewCitationMismatchError
    ) {
      return NextResponse.json(
        { error: error.message, ...('fields' in error && error.fields.length ? { fields: error.fields } : {}) },
        { status: 422 },
      );
    }
    if (error instanceof ReviewApplyEvidenceError) {
      console.error('Approve error (nothing applied):', error);
      return NextResponse.json(
        { error: error.message, ...(error.field ? { fields: [error.field] } : {}) },
        { status: error.transient ? 503 : 422 },
      );
    }
    console.error('Approve error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
