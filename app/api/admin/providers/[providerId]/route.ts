import { NextResponse } from 'next/server';
import { getProvider, getProviderCamps, getProviderPendingProposals, updateProvider } from '@/lib/admin/provider-repository';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProviderCommunitySlug } from '@/lib/admin/community-access';

export async function GET(
  _req: Request,
  { params }: { params: { providerId: string } }
) {
  const communitySlug = await getProviderCommunitySlug(params.providerId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [provider, camps, proposals] = await Promise.all([
    getProvider(params.providerId),
    getProviderCamps(params.providerId),
    getProviderPendingProposals(params.providerId),
  ]);

  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ provider, camps, proposals });
}

export async function PATCH(
  request: Request,
  { params }: { params: { providerId: string } }
) {
  const communitySlug = await getProviderCommunitySlug(params.providerId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({}));
  const provider = await updateProvider(params.providerId, body);
  if (!provider) return NextResponse.json({ error: 'Not found or no valid fields' }, { status: 404 });

  return NextResponse.json(provider);
}
