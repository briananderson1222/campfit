import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { getAccreditationCampId, updateAccreditation } from '@/lib/admin/accreditation-repository';

export async function PATCH(request: Request, props: { params: Promise<{ accreditationId: string }> }) {
  const params = await props.params;
  const body = await request.json().catch(() => ({})) as {
    status?: string;
    scope?: string | null;
    notes?: string | null;
    lastVerifiedAt?: string | null;
    expiresAt?: string | null;
  };

  const campId = await getAccreditationCampId(params.accreditationId);
  if (!campId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const communitySlug = await getCampCommunitySlug(campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (
    body.status === undefined
    && body.scope === undefined
    && body.notes === undefined
    && body.lastVerifiedAt === undefined
    && body.expiresAt === undefined
  ) {
    return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
  }

  return NextResponse.json(await updateAccreditation(params.accreditationId, body));
}
