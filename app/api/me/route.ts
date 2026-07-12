import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { evaluateAdminAccess } from '@/lib/admin/access';
import { getUserAccessProfile } from '@/lib/user-repository';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ isAdmin: false });

  const { userRows, assignmentRows } = await getUserAccessProfile(user.id);

  // ADMIN_EMAILS env var grants admin regardless of DB row
  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim());
  const isAdmin = adminEmails.includes(user.email ?? '') || userRows[0]?.isAdmin === true;
  const tier = userRows[0]?.tier ?? 'FREE';
  const accessEval = evaluateAdminAccess({
    userId: user.id,
    email: user.email ?? '',
    isAdmin,
    assignments: assignmentRows,
    allowModerator: true,
  });
  const communities = 'access' in accessEval ? accessEval.access.communities : [];
  const moderatorCommunities = assignmentRows
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
