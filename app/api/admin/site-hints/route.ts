import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { createSiteHint, getSiteHints } from '@/lib/admin/site-hint-repository';

export async function GET(req: Request) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(req.url);
  const domain = searchParams.get('domain');
  if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });

  return NextResponse.json(await getSiteHints(domain));
}

export async function POST(req: Request) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { domain, hint, source = 'manual', sourceId } = await req.json();
  if (!domain || !hint) return NextResponse.json({ error: 'domain and hint required' }, { status: 400 });

  const siteHint = await createSiteHint({
    domain,
    hint: hint.trim(),
    source,
    sourceId: sourceId ?? null,
    createdBy: auth.access.email,
  });
  return NextResponse.json(siteHint, { status: 201 });
}
