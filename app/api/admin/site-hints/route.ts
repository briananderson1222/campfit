import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function GET(req: Request) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

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
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { domain, hint, source = 'manual', sourceId } = await req.json();
  if (!domain || !hint) return NextResponse.json({ error: 'domain and hint required' }, { status: 400 });

  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "CrawlSiteHint" (domain, hint, source, "sourceId", "createdBy")
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [domain, hint.trim(), source, sourceId ?? null, auth.access.email]
  );
  return NextResponse.json(rows[0], { status: 201 });
}
