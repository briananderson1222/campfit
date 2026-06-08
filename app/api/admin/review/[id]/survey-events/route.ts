import { NextResponse } from 'next/server';

import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunityScope } from '@/lib/admin/community-access';
import {
  getSurveyReviewEvents,
  isReviewSessionEventArray,
  replaceSurveyReviewEvents,
  SurveyReviewEventConflictError,
} from '@/lib/admin/survey-review-events';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const scope = await getProposalCommunityScope(params.id);
  if (!scope) return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });

  const auth = await requireAdminAccess({ communitySlug: scope.communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return NextResponse.json({ events: await getSurveyReviewEvents(params.id) });
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
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

  if (!isReviewSessionEventArray(events)) {
    return NextResponse.json({ error: 'Expected events to be an array of Survey ReviewSessionEvent resources.' }, { status: 400 });
  }

  if (expectedEventCount !== undefined && (typeof expectedEventCount !== 'number' || !Number.isInteger(expectedEventCount) || expectedEventCount < 0)) {
    return NextResponse.json({ error: 'Expected expectedEventCount to be a non-negative integer.' }, { status: 400 });
  }

  try {
    await replaceSurveyReviewEvents({
      proposalId: params.id,
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
    throw error;
  }

  return NextResponse.json({ ok: true, count: events.length });
}
