import { getPool } from '@/lib/db';

export async function updateFlagStatus(flagId: string, status: string, resolvedBy: string) {
  const { rows } = await getPool().query(
    `UPDATE "ReviewFlag"
     SET status = $2,
         "resolvedBy" = CASE WHEN $2 = 'OPEN' THEN NULL ELSE $3 END,
         "resolvedAt" = CASE WHEN $2 = 'OPEN' THEN NULL ELSE now() END
     WHERE id = $1
     RETURNING *`,
    [flagId, status, resolvedBy],
  );
  return rows[0];
}
