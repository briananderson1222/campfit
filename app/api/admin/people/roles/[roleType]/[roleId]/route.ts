import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { deletePersonRole } from '@/lib/admin/entity-admin-repository';

export async function DELETE(
  _request: Request,
  props: { params: Promise<{ roleType: string; roleId: string }> }
) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const roleType = params.roleType === 'camp' ? 'camp'
    : params.roleType === 'provider' ? 'provider'
      : null;
  if (!roleType) return NextResponse.json({ error: 'Invalid role type' }, { status: 400 });

  const rowCount = await deletePersonRole(roleType, params.roleId);
  if (!rowCount) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
