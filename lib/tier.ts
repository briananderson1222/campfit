import { getPool } from "@/lib/db";

export type UserTier = "FREE" | "PREMIUM";

export async function getUserTier(userId: string): Promise<UserTier> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT tier FROM "User" WHERE id = $1`,
    [userId]
  );
  return (result.rows[0]?.tier as UserTier) ?? "FREE";
}

export const FREE_SAVE_LIMIT = 5;
