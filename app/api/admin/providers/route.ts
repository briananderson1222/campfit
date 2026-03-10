import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProviders, createProvider } from '@/lib/admin/provider-repository';

export async function GET(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const community = searchParams.get('community') ?? 'denver';

  const providers = await getProviders(community);
  return NextResponse.json(providers);
}

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const provider = await createProvider(body);
  return NextResponse.json(provider, { status: 201 });
}
