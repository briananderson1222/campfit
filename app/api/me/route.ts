import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ isAdmin: false });

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT "isAdmin", tier FROM "User" WHERE id = $1`,
    [user.id]
  );

  // ADMIN_EMAILS env var grants admin regardless of DB row
  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim());
  const isAdmin = adminEmails.includes(user.email ?? '') || rows[0]?.isAdmin === true;
  const tier = rows[0]?.tier ?? 'FREE';

  return NextResponse.json({ isAdmin, tier, isPremium: tier === 'PREMIUM' });
}
