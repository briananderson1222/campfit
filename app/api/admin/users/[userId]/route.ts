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
  const { tier, isAdmin } = body as { tier?: string; isAdmin?: boolean };

  const pool = getPool();

  // Upsert into User table (may not exist yet if they never hit an auth callback)
  const updates: string[] = [];
  const values: unknown[] = [params.userId];

  if (tier !== undefined) {
    values.push(tier);
    updates.push(`tier = $${values.length}`);
  }
  if (isAdmin !== undefined) {
    values.push(isAdmin);
    updates.push(`"isAdmin" = $${values.length}`);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  await pool.query(
    `INSERT INTO "User" (id, email, tier, "isAdmin")
     SELECT $1, email, 'FREE', false FROM auth.users WHERE id = $1
     ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}, "updatedAt" = now()`,
    values
  );

  return NextResponse.json({ ok: true });
}
