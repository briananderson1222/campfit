import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ isAdmin: false });

  // Check env var first (fast), then DB
  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim());
  if (adminEmails.includes(user.email ?? '')) {
    return NextResponse.json({ isAdmin: true });
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT "isAdmin" FROM "User" WHERE id = $1`,
    [user.id]
  );
  return NextResponse.json({ isAdmin: rows[0]?.isAdmin === true });
}
