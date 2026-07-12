import { getPool } from '@/lib/db';

export async function getAccreditationCampId(accreditationId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ campId: string }>(
    `SELECT "campId" FROM "CampAccreditation" WHERE id = $1`,
    [accreditationId],
  );
  return rows[0]?.campId ?? null;
}

export async function updateAccreditation(
  accreditationId: string,
  body: {
    status?: string;
    scope?: string | null;
    notes?: string | null;
    lastVerifiedAt?: string | null;
    expiresAt?: string | null;
  },
) {
  const sets: string[] = [];
  const values: unknown[] = [accreditationId];
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

  const { rows } = await getPool().query(
    `UPDATE "CampAccreditation"
     SET ${sets.join(', ')}
     WHERE id = $1
     RETURNING *`,
    values,
  );
  return rows[0];
}
