import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getFlagCommunity } from '@/lib/admin/community-access';
import { updateFlagStatus } from '@/lib/admin/flag-repository';

export async function PATCH(request: Request, props: { params: Promise<{ flagId: string }> }) {
  const params = await props.params;
  const flagContext = await getFlagCommunity(params.flagId);
  if (!flagContext) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const auth = await requireAdminAccess({
    communitySlug: flagContext.communitySlug,
    allowModerator: flagContext.entityType !== 'PERSON',
  });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({})) as { action?: 'resolve' | 'dismiss' | 'reopen' };
  const action = body.action ?? 'resolve';

  const status = action === 'dismiss'
    ? 'DISMISSED'
    : action === 'reopen'
      ? 'OPEN'
      : 'RESOLVED';

  return NextResponse.json(await updateFlagStatus(params.flagId, status, auth.access.email));
}
