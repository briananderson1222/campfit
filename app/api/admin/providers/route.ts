import { NextResponse } from 'next/server';
import { getProviders, createProvider } from '@/lib/admin/provider-repository';
import { requireAdminAccess } from '@/lib/admin/access';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const community = searchParams.get('community') ?? 'denver';
  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const providers = await getProviders(community);
  return NextResponse.json(providers);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const communitySlug = typeof body.communitySlug === 'string' && body.communitySlug.trim()
    ? body.communitySlug.trim()
    : 'denver';
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const provider = await createProvider({ ...body, communitySlug });
  return NextResponse.json(provider, { status: 201 });
}
