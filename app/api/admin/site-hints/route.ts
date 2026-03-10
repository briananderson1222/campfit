import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get('domain');
  if (!domain) return NextResponse.json({ error: 'domain required' }, { status: 400 });

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM "CrawlSiteHint" WHERE domain = $1 ORDER BY "createdAt" ASC`,
    [domain]
  );
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { domain, hint, source = 'manual', sourceId } = await req.json();
  if (!domain || !hint) return NextResponse.json({ error: 'domain and hint required' }, { status: 400 });

  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "CrawlSiteHint" (domain, hint, source, "sourceId", "createdBy")
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [domain, hint.trim(), source, sourceId ?? null, user.email]
  );
  return NextResponse.json(rows[0], { status: 201 });
}
