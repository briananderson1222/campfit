import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function PATCH(
  request: Request,
  { params }: { params: { userId: string } }
) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();
  const { tier, isAdmin, email, assignments } = body as {
    tier?: string;
    isAdmin?: boolean;
    email?: string;
    assignments?: Array<{ communitySlug: string; role?: 'ADMIN' | 'MODERATOR' }>;
  };

  const pool = getPool();

  // $1 = id, $2 = email; update params start at $3
  const queryValues: unknown[] = [params.userId, email ?? ''];
  const updates: string[] = [];

  if (tier !== undefined) {
    queryValues.push(tier);
    updates.push(`tier = $${queryValues.length}`);
  }
  if (isAdmin !== undefined) {
    queryValues.push(isAdmin);
    updates.push(`"isAdmin" = $${queryValues.length}`);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // Upsert without referencing auth.users (pooler lacks permission)
  await pool.query(
    `INSERT INTO "User" (id, email, tier, "isAdmin")
     VALUES ($1, $2, 'FREE', false)
     ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}, "updatedAt" = now()`,
    queryValues
  );

  if (assignments) {
    await pool.query(`DELETE FROM "CommunityModeratorAssignment" WHERE "userId" = $1`, [params.userId]);
    for (const assignment of assignments) {
      if (!assignment.communitySlug) continue;
      await pool.query(
        `INSERT INTO "CommunityModeratorAssignment" ("userId", "communitySlug", role, "createdBy")
         VALUES ($1, $2, $3, $4)`,
        [params.userId, assignment.communitySlug, assignment.role ?? 'MODERATOR', auth.access.email],
      );
    }
  }

  return NextResponse.json({ ok: true });
}
