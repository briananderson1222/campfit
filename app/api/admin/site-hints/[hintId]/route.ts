import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function PATCH(req: Request, { params }: { params: { hintId: string } }) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json() as { active?: boolean; hint?: string };
  const pool = getPool();

  const sets: string[] = ['"updatedAt" = now()'];
  const vals: unknown[] = [params.hintId];
  if (body.active !== undefined) { sets.push(`active = $${vals.length + 1}`); vals.push(body.active); }
  if (body.hint !== undefined) { sets.push(`hint = $${vals.length + 1}`); vals.push(body.hint.trim()); }

  const { rows } = await pool.query(
    `UPDATE "CrawlSiteHint" SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    vals
  );
  return NextResponse.json(rows[0]);
}

export async function DELETE(_req: Request, { params }: { params: { hintId: string } }) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pool = getPool();
  await pool.query(`DELETE FROM "CrawlSiteHint" WHERE id = $1`, [params.hintId]);
  return NextResponse.json({ ok: true });
}
