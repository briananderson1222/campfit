import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCommunitySummaries } from '@/lib/admin/community-repository';

export async function GET() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const communities = await getCommunitySummaries(auth.access);
  return NextResponse.json({ communities });
}
