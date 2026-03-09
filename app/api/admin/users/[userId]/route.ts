import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function PATCH(
  request: Request,
  { params }: { params: { userId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { tier, isAdmin, email } = body as { tier?: string; isAdmin?: boolean; email?: string };

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

  return NextResponse.json({ ok: true });
}
