import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function DELETE(
  _request: Request,
  { params }: { params: { roleType: string; roleId: string } },
) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const table = params.roleType === 'camp' ? 'CampPersonRole'
    : params.roleType === 'provider' ? 'ProviderPersonRole'
      : null;
  if (!table) return NextResponse.json({ error: 'Invalid role type' }, { status: 400 });

  const { rowCount } = await getPool().query(
    `DELETE FROM "${table}" WHERE id = $1`,
    [params.roleId],
  );
  if (!rowCount) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
