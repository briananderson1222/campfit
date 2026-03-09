import { createClient as createAdminClient } from '@supabase/supabase-js';
import { getPool } from "@/lib/db";
import { Users } from "lucide-react";
import { UsersTable } from "./users-table";

export const dynamic = "force-dynamic";

async function getUsers() {
  // Use service role to access auth.users
  const supabaseAdmin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: { users: authUsers }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;

  const pool = getPool();
  const { rows: profiles } = await pool.query(
    `SELECT id, tier, "isAdmin", name,
      COALESCE((SELECT COUNT(*) FROM "SavedCamp" sc WHERE sc."userId" = "User".id), 0)::int AS "savedCount"
     FROM "User"`
  );
  const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));

  return authUsers.map(u => ({
    id: u.id,
    email: u.email ?? '',
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
    name: profileMap[u.id]?.name ?? null,
    tier: profileMap[u.id]?.tier ?? 'FREE',
    isAdmin: profileMap[u.id]?.isAdmin ?? false,
    savedCount: profileMap[u.id]?.savedCount ?? 0,
  }));
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
