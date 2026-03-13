import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function GET() {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const supabaseAdmin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: { users: authUsers }, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const pool = getPool();
  const { rows: profiles } = await pool.query(
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
  const profileMap = Object.fromEntries(profiles.map((p: { id: string }) => [p.id, p]));

  const users = authUsers.map(u => ({
    id: u.id,
    email: u.email ?? '',
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
    name: (profileMap[u.id] as { name?: string })?.name ?? null,
    tier: (profileMap[u.id] as { tier?: string })?.tier ?? 'FREE',
    isAdmin: (profileMap[u.id] as { isAdmin?: boolean })?.isAdmin ?? false,
    assignments: (profileMap[u.id] as { assignments?: Array<{ communitySlug: string; role: string }> })?.assignments ?? [],
    savedCount: (profileMap[u.id] as { savedCount?: number })?.savedCount ?? 0,
  }));

  return NextResponse.json({ users });
}
