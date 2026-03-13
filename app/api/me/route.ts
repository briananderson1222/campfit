import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';
import { evaluateAdminAccess } from '@/lib/admin/access';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ isAdmin: false });

  const pool = getPool();
  const [userRows, assignmentRows] = await Promise.all([
    pool.query(
    `SELECT "isAdmin", tier FROM "User" WHERE id = $1`,
    [user.id]
    ),
    pool.query(
      `SELECT "communitySlug", role FROM "CommunityModeratorAssignment" WHERE "userId" = $1`,
      [user.id]
    ),
  ]);

  // ADMIN_EMAILS env var grants admin regardless of DB row
  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim());
  const isAdmin = adminEmails.includes(user.email ?? '') || userRows.rows[0]?.isAdmin === true;
  const tier = userRows.rows[0]?.tier ?? 'FREE';
  const accessEval = evaluateAdminAccess({
    userId: user.id,
    email: user.email ?? '',
    isAdmin,
    assignments: assignmentRows.rows as Array<{ communitySlug: string; role: 'ADMIN' | 'MODERATOR' }>,
    allowModerator: true,
  });
  const communities = 'access' in accessEval ? accessEval.access.communities : [];
  const moderatorCommunities = assignmentRows.rows
    .filter((row: any) => row.role === 'MODERATOR')
    .map((row: any) => row.communitySlug);

  return NextResponse.json({
    isAdmin,
    isModerator: communities.length > 0,
    communities,
    moderatorCommunities,
    tier,
    isPremium: tier === 'PREMIUM',
  });
}
