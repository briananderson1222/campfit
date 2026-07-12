import { getPool } from '@/lib/db';

export async function getSavedCampIds(userId: string): Promise<string[]> {
  const result = await getPool().query<{ campId: string }>(
    `SELECT "campId" FROM "SavedCamp" WHERE "userId" = $1`,
    [userId]
  );
  return result.rows.map((r) => r.campId);
}

export async function upsertSaveUser(user: { id: string; email: string; name: string }): Promise<void> {
  await getPool().query(
    `INSERT INTO "User" (id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = COALESCE(NULLIF(EXCLUDED.name, ''), "User".name)`,
    [user.id, user.email, user.name]
  );
}

export async function countSavedCamps(userId: string): Promise<string> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) FROM "SavedCamp" WHERE "userId" = $1`,
    [userId]
  );
  return result.rows[0].count;
}

export async function saveCamp(userId: string, campId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO "SavedCamp" (id, "userId", "campId")
     VALUES (gen_random_uuid()::text, $1, $2)
     ON CONFLICT ("userId", "campId") DO NOTHING`,
    [userId, campId]
  );
}

export async function deleteSavedCamp(userId: string, campId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM "SavedCamp" WHERE "userId" = $1 AND "campId" = $2`,
    [userId, campId]
  );
}
