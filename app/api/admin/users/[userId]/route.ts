import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { createModeratorAssignment, deleteModeratorAssignments, upsertAdminUser } from '@/lib/admin/user-repository';

export async function PATCH(request: Request, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();
  const { tier, isAdmin, email, assignments } = body as {
    tier?: string;
    isAdmin?: boolean;
    email?: string;
    assignments?: Array<{ communitySlug: string; role?: 'ADMIN' | 'MODERATOR' }>;
  };

  if (tier === undefined && isAdmin === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // Upsert without referencing auth.users (pooler lacks permission)
  await upsertAdminUser(params.userId, email ?? '', { tier, isAdmin });

  if (assignments) {
    await deleteModeratorAssignments(params.userId);
    for (const assignment of assignments) {
      if (!assignment.communitySlug) continue;
      await createModeratorAssignment(params.userId, assignment, auth.access.email);
    }
  }

  return NextResponse.json({ ok: true });
}
