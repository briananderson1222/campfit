import { getPool } from '@/lib/db';

type FieldAttestationTarget = {
  id: string;
  entityType: 'CAMP' | 'PROVIDER' | 'PERSON';
  entityId: string;
};

export async function getFieldAttestationTarget(attestationId: string): Promise<FieldAttestationTarget | null> {
  const attestationRes = await getPool().query<FieldAttestationTarget>(
    `SELECT id, "entityType", "entityId" FROM "FieldAttestation" WHERE id = $1`,
    [attestationId],
  );
  return attestationRes.rows[0] ?? null;
}

export async function updateFieldAttestation(
  attestationId: string,
  notes: string | null,
  action: 'recheck' | 'mark_stale' | 'invalidate' | undefined,
  invalidationReason: string | null | undefined,
): Promise<unknown> {
  const sets = ['notes = COALESCE($2, notes)'];
  const values: unknown[] = [attestationId, notes];

  if (action === 'recheck') {
    sets.push(`status = 'ACTIVE'`);
    sets.push(`"lastRecheckedAt" = now()`);
    sets.push(`"invalidatedAt" = NULL`);
    sets.push(`"invalidationReason" = NULL`);
  } else if (action === 'mark_stale') {
    sets.push(`status = 'STALE'`);
  } else if (action === 'invalidate') {
    values.push(invalidationReason?.trim() || 'Invalidated by admin review');
    sets.push(`status = 'INVALIDATED'`);
    sets.push(`"invalidatedAt" = now()`);
    sets.push(`"invalidationReason" = $${values.length}`);
  }

  const { rows } = await getPool().query(
    `UPDATE "FieldAttestation"
     SET ${sets.join(', ')}
     WHERE id = $1
     RETURNING *`,
    values,
  );
  return rows[0];
}
