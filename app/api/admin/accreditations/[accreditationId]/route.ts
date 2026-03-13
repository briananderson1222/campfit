import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';

export async function PATCH(
  request: Request,
  { params }: { params: { accreditationId: string } },
) {
  const body = await request.json().catch(() => ({})) as {
    status?: string;
    scope?: string | null;
    notes?: string | null;
    lastVerifiedAt?: string | null;
    expiresAt?: string | null;
  };

  const pool = getPool();
  const accreditationRes = await pool.query<{ campId: string }>(
    `SELECT "campId" FROM "CampAccreditation" WHERE id = $1`,
    [params.accreditationId],
  );
  const accreditation = accreditationRes.rows[0];
  if (!accreditation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const communitySlug = await getCampCommunitySlug(accreditation.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sets: string[] = [];
  const values: unknown[] = [params.accreditationId];
  if (body.status !== undefined) {
    values.push(body.status.trim() || 'ACTIVE');
    sets.push(`status = $${values.length}`);
  }
  if (body.scope !== undefined) {
    values.push(body.scope?.trim() || null);
    sets.push(`scope = $${values.length}`);
  }
  if (body.notes !== undefined) {
    values.push(body.notes?.trim() || null);
    sets.push(`notes = $${values.length}`);
  }
  if (body.lastVerifiedAt !== undefined) {
    values.push(body.lastVerifiedAt ? new Date(body.lastVerifiedAt).toISOString() : null);
    sets.push(`"lastVerifiedAt" = $${values.length}`);
  }
  if (body.expiresAt !== undefined) {
    values.push(body.expiresAt ? new Date(body.expiresAt).toISOString() : null);
    sets.push(`"expiresAt" = $${values.length}`);
  }
  if (sets.length === 0) return NextResponse.json({ error: 'No updates provided' }, { status: 400 });

  const { rows } = await pool.query(
    `UPDATE "CampAccreditation"
     SET ${sets.join(', ')}
     WHERE id = $1
     RETURNING *`,
    values,
  );
  return NextResponse.json(rows[0]);
}
