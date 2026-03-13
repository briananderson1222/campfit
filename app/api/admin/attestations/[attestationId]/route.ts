import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug, getProviderCommunitySlug } from '@/lib/admin/community-access';

export async function PATCH(
  request: Request,
  { params }: { params: { attestationId: string } },
) {
  const body = await request.json().catch(() => ({})) as {
    action?: 'recheck' | 'mark_stale' | 'invalidate';
    notes?: string | null;
    invalidationReason?: string | null;
  };

  const pool = getPool();
  const attestationRes = await pool.query<{
    id: string;
    entityType: 'CAMP' | 'PROVIDER' | 'PERSON';
    entityId: string;
  }>(
    `SELECT id, "entityType", "entityId" FROM "FieldAttestation" WHERE id = $1`,
    [params.attestationId],
  );
  const attestation = attestationRes.rows[0];
  if (!attestation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const communitySlug = attestation.entityType === 'CAMP'
    ? await getCampCommunitySlug(attestation.entityId)
    : attestation.entityType === 'PROVIDER'
      ? await getProviderCommunitySlug(attestation.entityId)
      : null;
  const auth = await requireAdminAccess({ communitySlug, allowModerator: attestation.entityType !== 'PERSON' });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sets = ['notes = COALESCE($2, notes)'];
  const values: unknown[] = [params.attestationId, body.notes?.trim() || null];

  if (body.action === 'recheck') {
    sets.push(`status = 'ACTIVE'`);
    sets.push(`"lastRecheckedAt" = now()`);
    sets.push(`"invalidatedAt" = NULL`);
    sets.push(`"invalidationReason" = NULL`);
  } else if (body.action === 'mark_stale') {
    sets.push(`status = 'STALE'`);
  } else if (body.action === 'invalidate') {
    values.push(body.invalidationReason?.trim() || 'Invalidated by admin review');
    sets.push(`status = 'INVALIDATED'`);
    sets.push(`"invalidatedAt" = now()`);
    sets.push(`"invalidationReason" = $${values.length}`);
  }

  const { rows } = await pool.query(
    `UPDATE "FieldAttestation"
     SET ${sets.join(', ')}
     WHERE id = $1
     RETURNING *`,
    values,
  );
  return NextResponse.json(rows[0]);
}
