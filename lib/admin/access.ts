import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export type AdminAccess = {
  userId: string;
  email: string;
  isAdmin: boolean;
  isModerator: boolean;
  communities: string[];
};

export function evaluateAdminAccess(input: {
  userId: string;
  email: string;
  isAdmin: boolean;
  assignments: Array<{ communitySlug: string; role: 'ADMIN' | 'MODERATOR' }>;
  requestedCommunity?: string | null;
  allowModerator?: boolean;
}): { access: AdminAccess } | { error: 'Forbidden'; status: 403 } {
  const communities = input.assignments.map((row) => row.communitySlug);
  const requestedCommunity = input.requestedCommunity ?? null;
  const isModerator = input.assignments.some((row) =>
    row.role === 'MODERATOR' && (!requestedCommunity || row.communitySlug === requestedCommunity),
  );

  if (input.isAdmin || (input.allowModerator && isModerator)) {
    return {
      access: {
        userId: input.userId,
        email: input.email,
        isAdmin: input.isAdmin,
        isModerator,
        communities,
      },
    };
  }

  return { error: 'Forbidden', status: 403 };
}

export async function requireAdminAccess(opts?: {
  communitySlug?: string | null;
  allowModerator?: boolean;
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id || !user.email) return { error: 'Unauthorized', status: 401 as const };

  const pool = getPool();
  const [userRes, assignmentRes] = await Promise.all([
    pool.query<{ isAdmin: boolean; tier: string }>(
      `SELECT "isAdmin", tier FROM "User" WHERE id = $1`,
      [user.id],
    ),
    pool.query<{ communitySlug: string; role: 'ADMIN' | 'MODERATOR' }>(
      `SELECT "communitySlug", role FROM "CommunityModeratorAssignment" WHERE "userId" = $1`,
      [user.id],
    ),
  ]);

  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const isAdmin = adminEmails.includes(user.email) || userRes.rows[0]?.isAdmin === true;
  return evaluateAdminAccess({
    userId: user.id,
    email: user.email,
    isAdmin,
    assignments: assignmentRes.rows,
    requestedCommunity: opts?.communitySlug,
    allowModerator: opts?.allowModerator,
  });
}
