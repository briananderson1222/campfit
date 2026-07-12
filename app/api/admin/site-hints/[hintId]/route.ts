import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { deleteSiteHint, updateSiteHint } from '@/lib/admin/site-hint-repository';

export async function PATCH(req: Request, props: { params: Promise<{ hintId: string }> }) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json() as { active?: boolean; hint?: string };
  return NextResponse.json(await updateSiteHint(params.hintId, body));
}

export async function DELETE(_req: Request, props: { params: Promise<{ hintId: string }> }) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await deleteSiteHint(params.hintId);
  return NextResponse.json({ ok: true });
}
