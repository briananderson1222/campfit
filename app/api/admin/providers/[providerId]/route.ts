import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProvider, getProviderCamps, getProviderPendingProposals, updateProvider } from '@/lib/admin/provider-repository';

export async function GET(
  _req: Request,
  { params }: { params: { providerId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const provider = await updateProvider(params.providerId, body);
  if (!provider) return NextResponse.json({ error: 'Not found or no valid fields' }, { status: 404 });

  return NextResponse.json(provider);
}
