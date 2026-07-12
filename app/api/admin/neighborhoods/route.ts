import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { createNeighborhood, getNeighborhoodNames } from '@/lib/admin/community-repository';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const community = searchParams.get('community') ?? 'denver';
  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json(await getNeighborhoodNames(community));
}

export async function POST(req: Request) {
  const { communitySlug = 'denver', name } = await req.json();
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });

  await createNeighborhood(communitySlug, name.trim());
  return NextResponse.json({ ok: true }, { status: 201 });
}
