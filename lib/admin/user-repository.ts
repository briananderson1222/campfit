import { getPool } from '@/lib/db';

export type AdminUserProfile = {
  id: string;
  name?: string;
  tier: 'FREE' | 'PREMIUM' | null;
  isAdmin: boolean;
  assignments: Array<{ communitySlug: string; role: 'ADMIN' | 'MODERATOR' }>;
  savedCount: number;
};

export async function getAdminUserProfiles(): Promise<AdminUserProfile[]> {
  const { rows } = await getPool().query<AdminUserProfile>(
    `SELECT u.id, u.tier, u."isAdmin", u.name,
      COALESCE(
        json_agg(
          json_build_object('communitySlug', cma."communitySlug", 'role', cma.role)
        ) FILTER (WHERE cma.id IS NOT NULL),
        '[]'::json
      ) AS assignments,
      COALESCE((SELECT COUNT(*) FROM "SavedCamp" sc WHERE sc."userId" = u.id), 0)::int AS "savedCount"
     FROM "User" u
     LEFT JOIN "CommunityModeratorAssignment" cma ON cma."userId" = u.id
     GROUP BY u.id`
  );
  return rows;
}

export async function upsertAdminUser(
  userId: string,
  email: string,
  update: { tier?: string; isAdmin?: boolean },
): Promise<void> {
  const queryValues: unknown[] = [userId, email];
  const updates: string[] = [];
  if (update.tier !== undefined) {
    queryValues.push(update.tier);
    updates.push(`tier = $${queryValues.length}`);
  }
  if (update.isAdmin !== undefined) {
    queryValues.push(update.isAdmin);
    updates.push(`"isAdmin" = $${queryValues.length}`);
  }
  await getPool().query(
    `INSERT INTO "User" (id, email, tier, "isAdmin")
     VALUES ($1, $2, 'FREE', false)
     ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}, "updatedAt" = now()`,
    queryValues
  );
}

export async function deleteModeratorAssignments(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM "CommunityModeratorAssignment" WHERE "userId" = $1`, [userId]);
}

export async function createModeratorAssignment(
  userId: string,
  assignment: { communitySlug: string; role?: 'ADMIN' | 'MODERATOR' },
  createdBy: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO "CommunityModeratorAssignment" ("userId", "communitySlug", role, "createdBy")
         VALUES ($1, $2, $3, $4)`,
    [userId, assignment.communitySlug, assignment.role ?? 'MODERATOR', createdBy],
  );
}
