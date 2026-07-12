import { getPool } from '@/lib/db';

export async function getCampIdForReport(campId: string): Promise<{ id: string } | null> {
  const { rows: [camp] } = await getPool().query<{ id: string }>(
    `SELECT id FROM "Camp" WHERE id = $1`,
    [campId]
  );
  return camp ?? null;
}

export async function createCampReport(
  campId: string,
  userId: string,
  userEmail: string | undefined,
  type: 'WRONG_INFO' | 'MISSING_INFO' | 'CAMP_CLOSED' | 'OTHER',
  description: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO "CampReport" ("campId", "userId", "userEmail", type, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [campId, userId, userEmail, type, description]
  );
}
