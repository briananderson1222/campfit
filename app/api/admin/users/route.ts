import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { getPool } from '@/lib/db';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabaseAdmin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: { users: authUsers }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pool = getPool();
  const { rows: profiles } = await pool.query(
    `SELECT id, tier, "isAdmin", name,
      COALESCE((SELECT COUNT(*) FROM "SavedCamp" sc WHERE sc."userId" = "User".id), 0)::int AS "savedCount"
     FROM "User"`
  );
  const profileMap = Object.fromEntries(profiles.map((p: { id: string }) => [p.id, p]));

  const users = authUsers.map(u => ({
    id: u.id,
    email: u.email ?? '',
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
    name: (profileMap[u.id] as { name?: string })?.name ?? null,
    tier: (profileMap[u.id] as { tier?: string })?.tier ?? 'FREE',
    isAdmin: (profileMap[u.id] as { isAdmin?: boolean })?.isAdmin ?? false,
    savedCount: (profileMap[u.id] as { savedCount?: number })?.savedCount ?? 0,
  }));

  return NextResponse.json({ users });
}
