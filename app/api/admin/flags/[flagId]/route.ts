import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getFlagCommunity } from '@/lib/admin/community-access';

export async function PATCH(
  request: Request,
  { params }: { params: { flagId: string } },
) {
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

  const { rows } = await getPool().query(
    `UPDATE "ReviewFlag"
     SET status = $2,
         "resolvedBy" = CASE WHEN $2 = 'OPEN' THEN NULL ELSE $3 END,
         "resolvedAt" = CASE WHEN $2 = 'OPEN' THEN NULL ELSE now() END
     WHERE id = $1
     RETURNING *`,
    [params.flagId, status, auth.access.email],
  );

  return NextResponse.json(rows[0]);
}
