import { NextResponse } from 'next/server';

import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunityScope } from '@/lib/admin/community-access';
import { getProposal } from '@/lib/admin/review-repository';
import {
  getSurveyReviewEvents,
  isReviewSessionEventArray,
  replaceSurveyReviewEvents,
  SurveyReviewEventConflictError,
  SurveyReviewEventValidationError,
} from '@/lib/admin/survey-review-events';
import { SurveyReviewSessionStaleError } from '@/lib/admin/survey-review-sessions';

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const scope = await getProposalCommunityScope(params.id);
  if (!scope) return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });

  const auth = await requireAdminAccess({ communitySlug: scope.communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const reviewSessionId = new URL(request.url).searchParams.get('reviewSessionId') ?? undefined;
  return NextResponse.json({
    events: await getSurveyReviewEvents({
      proposalId: params.id,
      reviewSessionId,
    }),
  });
}

export async function PUT(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const scope = await getProposalCommunityScope(params.id);
  if (!scope) return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });

  const auth = await requireAdminAccess({ communitySlug: scope.communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => null);
  const events = body && typeof body === 'object' && 'events' in body
    ? (body as { events?: unknown }).events
    : undefined;
  const expectedEventCount = body && typeof body === 'object' && 'expectedEventCount' in body
    ? (body as { expectedEventCount?: unknown }).expectedEventCount
    : undefined;
  const reviewSessionId = body && typeof body === 'object' && 'reviewSessionId' in body
    ? (body as { reviewSessionId?: unknown }).reviewSessionId
    : undefined;

  if (typeof reviewSessionId !== 'string' || reviewSessionId.length === 0) {
    return NextResponse.json({ error: 'Expected reviewSessionId for Survey review event persistence.' }, { status: 400 });
  }

  if (!isReviewSessionEventArray(events)) {
    return NextResponse.json({ error: 'Expected events to be an array of Survey ReviewSessionEvent resources.' }, { status: 400 });
  }

  if (expectedEventCount !== undefined && (typeof expectedEventCount !== 'number' || !Number.isInteger(expectedEventCount) || expectedEventCount < 0)) {
    return NextResponse.json({ error: 'Expected expectedEventCount to be a non-negative integer.' }, { status: 400 });
  }

  try {
    const proposal = await getProposal(params.id);
    if (!proposal) return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });

    await replaceSurveyReviewEvents({
      proposalId: params.id,
      proposal,
      reviewSessionId,
      events,
      actorEmail: auth.access.email,
      expectedEventCount,
    });
  } catch (error) {
    if (error instanceof SurveyReviewEventConflictError) {
      return NextResponse.json({
        error: 'Survey review events changed before this snapshot could be saved.',
        currentEventCount: error.currentEventCount,
      }, { status: 409 });
    }
    if (error instanceof SurveyReviewEventValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SurveyReviewSessionStaleError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true, count: events.length });
}
