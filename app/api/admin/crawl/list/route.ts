import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM "CrawlRun" ORDER BY "startedAt" DESC LIMIT 50`
  );
  const runs = result.rows;

  // Resolve campIds → camp names for targeted runs
  const allCampIds = Array.from(new Set(runs.flatMap((r: { campIds: string[] | null }) => r.campIds ?? [])));
  const campNames: Record<string, string> = {};
  if (allCampIds.length > 0) {
    const camps = await pool.query(
      `SELECT id, name FROM "Camp" WHERE id = ANY($1)`, [allCampIds]
    );
    camps.rows.forEach((c: { id: string; name: string }) => { campNames[c.id] = c.name; });
  }

  return NextResponse.json({ runs, campNames });
}
