import { getPool } from '@/lib/db';

type UserAccessRow = { isAdmin: boolean; tier: string };
export type UserAssignmentRow = { communitySlug: string; role: 'ADMIN' | 'MODERATOR' };

export async function getUserAccessProfile(userId: string) {
  const pool = getPool();
  const [userRows, assignmentRows] = await Promise.all([
    pool.query<UserAccessRow>(
    `SELECT "isAdmin", tier FROM "User" WHERE id = $1`,
    [userId]
    ),
    pool.query<UserAssignmentRow>(
      `SELECT "communitySlug", role FROM "CommunityModeratorAssignment" WHERE "userId" = $1`,
      [userId]
    ),
  ]);
  return { userRows: userRows.rows, assignmentRows: assignmentRows.rows };
}
