import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getReportCommunitySlug } from '@/lib/admin/community-access';
import { updateCampReportReview } from '@/lib/admin/report-repository';

export async function PATCH(req: Request, props: { params: Promise<{ reportId: string }> }) {
  const params = await props.params;
  const communitySlug = await getReportCommunitySlug(params.reportId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const status = body.status === 'REVIEWED' ? 'REVIEWED' : 'DISMISSED';
  const adminNotes = typeof body.adminNotes === 'string' ? body.adminNotes.trim() || null : null;

  const rowCount = await updateCampReportReview(params.reportId, status, adminNotes);

  if (!rowCount) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  return NextResponse.json({ ok: true, status });
}
