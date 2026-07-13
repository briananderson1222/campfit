import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { writePersonChangeLogs } from '@/lib/admin/changelog-repository';
import { getAdminPersonDetail, updateAdminPerson, type UpdateAdminPersonInput } from '@/lib/admin/person-repository';
import { RepositoryConnectionError } from '@/lib/admin/repository-errors';

export async function GET(_request: Request, props: { params: Promise<{ personId: string }> }) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const detail = await getAdminPersonDetail(params.personId);
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(detail);
}

export async function PATCH(request: Request, props: { params: Promise<{ personId: string }> }) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({})) as {
    fullName?: string;
    bio?: string | null;
    contacts?: Array<{ id?: string; type?: string; value?: string; label?: string | null }>;
  } satisfies UpdateAdminPersonInput;
  try {
    const { existingPerson, contactsBefore } = await updateAdminPerson(params.personId, body);

    const logs = [];
    if (body.fullName !== undefined) {
      logs.push({
        personId: params.personId,
        changedBy: auth.access.email,
        fieldName: 'fullName',
        oldValue: existingPerson?.fullName ?? null,
        newValue: body.fullName.trim(),
        changeType: existingPerson?.fullName ? 'UPDATE' as const : 'FIELD_POPULATED' as const,
      });
    }
    if (body.bio !== undefined) {
      logs.push({
        personId: params.personId,
        changedBy: auth.access.email,
        fieldName: 'bio',
        oldValue: existingPerson?.bio ?? null,
        newValue: body.bio?.trim() || null,
        changeType: existingPerson?.bio ? 'UPDATE' as const : 'FIELD_POPULATED' as const,
      });
    }
    if (Array.isArray(body.contacts)) {
      logs.push({
        personId: params.personId,
        changedBy: auth.access.email,
        fieldName: 'contacts',
        oldValue: contactsBefore,
        newValue: body.contacts,
        changeType: contactsBefore.length ? 'UPDATE' as const : 'FIELD_POPULATED' as const,
      });
    }
    await writePersonChangeLogs(logs).catch((error) => {
      console.error('[person PATCH] writePersonChangeLogs failed:', error);
    });

    return GET(request, { params: Promise.resolve(params) });
  } catch (error) {
    if (error instanceof RepositoryConnectionError) throw error.cause;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 500 });
  }
}
