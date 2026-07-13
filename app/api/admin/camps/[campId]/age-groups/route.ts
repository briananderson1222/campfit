import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { replaceAdminCampAgeGroups, type AgeGroupInput } from '@/lib/admin/camp-repository';
import { RepositoryConnectionError } from '@/lib/admin/repository-errors';

/** Replace all age groups for a camp. */
export async function PUT(req: Request, props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { ageGroups } = await req.json() as { ageGroups: AgeGroupInput[] };
  if (!Array.isArray(ageGroups)) return NextResponse.json({ error: 'ageGroups array required' }, { status: 400 });

  try {
    const rows = await replaceAdminCampAgeGroups(params.campId, ageGroups, auth.access.email);
    return NextResponse.json(rows);
  } catch (err) {
    if (err instanceof RepositoryConnectionError) throw err.cause;
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
