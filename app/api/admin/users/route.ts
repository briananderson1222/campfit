import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const pool = getPool();

  // Join auth.users (email, created_at, last_sign_in_at) with public User (tier, isAdmin)
  const { rows } = await pool.query(`
    SELECT
      au.id,
      au.email,
      au.created_at       AS "createdAt",
      au.last_sign_in_at  AS "lastSignInAt",
      u.tier,
      u."isAdmin",
      u."stripeCustomerId",
      u.name,
      (SELECT COUNT(*) FROM "SavedCamp" sc WHERE sc."userId" = au.id) AS "savedCount"
    FROM auth.users au
    LEFT JOIN "User" u ON u.id = au.id
    ORDER BY au.created_at DESC
  `);

  return NextResponse.json({ users: rows });
}
