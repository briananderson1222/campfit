import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProviderProposalForRejection, markProviderProposalRejected } from '@/lib/admin/provider-repository';

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const proposal = await getProviderProposalForRejection(params.id);
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireAdminAccess({ communitySlug: proposal.communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({})) as { reviewerNotes?: string };
  const rowCount = await markProviderProposalRejected(
    params.id,
    auth.access.email,
    body.reviewerNotes?.trim() || null,
  );
  if (!rowCount) return NextResponse.json({ error: 'Not found or already reviewed' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
