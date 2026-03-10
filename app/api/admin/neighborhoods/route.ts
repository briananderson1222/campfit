import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const community = searchParams.get('community') ?? 'denver';
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1 ORDER BY name ASC`,
    [community]
  );
  return NextResponse.json(rows.map(r => r.name));
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { communitySlug = 'denver', name } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const pool = getPool();
  await pool.query(
    `INSERT INTO "CommunityNeighborhood"("communitySlug", name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [communitySlug, name.trim()]
  );
  return NextResponse.json({ ok: true }, { status: 201 });
}
