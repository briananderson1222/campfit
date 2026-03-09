import { getPool } from "@/lib/db";
import { Users } from "lucide-react";
import { UsersTable } from "./users-table";

export const dynamic = "force-dynamic";

async function getUsers() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      au.id,
      au.email,
      au.created_at       AS "createdAt",
      au.last_sign_in_at  AS "lastSignInAt",
      u.tier,
      u."isAdmin",
      u.name,
      COALESCE((SELECT COUNT(*) FROM "SavedCamp" sc WHERE sc."userId" = au.id), 0)::int AS "savedCount"
    FROM auth.users au
    LEFT JOIN "User" u ON u.id = au.id
    ORDER BY au.created_at DESC
  `);
  return rows;
}

export default async function AdminUsersPage() {
  const users = await getUsers();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-bark-700 flex items-center gap-2">
            <Users className="w-6 h-6 text-pine-500" />
            Users
          </h1>
          <p className="text-sm text-bark-400 mt-0.5">{users.length} registered accounts</p>
        </div>
      </div>

      <UsersTable initialUsers={users} />
    </div>
  );
}
