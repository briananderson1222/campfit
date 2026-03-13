import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const community = searchParams.get('community') ?? 'denver';
  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1 ORDER BY name ASC`,
    [community]
  );
  return NextResponse.json(rows.map(r => r.name));
}

export async function POST(req: Request) {
  const { communitySlug = 'denver', name } = await req.json();
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const pool = getPool();
  await pool.query(
    `INSERT INTO "CommunityNeighborhood"("communitySlug", name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [communitySlug, name.trim()]
  );
  return NextResponse.json({ ok: true }, { status: 201 });
}
