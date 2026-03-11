import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function PATCH(
  req: Request,
  { params }: { params: { reportId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
