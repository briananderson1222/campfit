import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getReportCommunitySlug } from '@/lib/admin/community-access';

export async function PATCH(
  req: Request,
  { params }: { params: { reportId: string } }
) {
  const communitySlug = await getReportCommunitySlug(params.reportId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const status = body.status === 'REVIEWED' ? 'REVIEWED' : 'DISMISSED';
  const adminNotes = typeof body.adminNotes === 'string' ? body.adminNotes.trim() || null : null;

  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE "CampReport" SET status = $1, "adminNotes" = $2, "updatedAt" = now() WHERE id = $3`,
    [status, adminNotes, params.reportId]
  );

  if (!rowCount) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  return NextResponse.json({ ok: true, status });
}
