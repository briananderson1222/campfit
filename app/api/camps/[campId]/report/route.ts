import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

const VALID_TYPES = ['WRONG_INFO', 'MISSING_INFO', 'CAMP_CLOSED', 'OTHER'] as const;
type ReportType = typeof VALID_TYPES[number];

export async function POST(
  req: Request,
  { params }: { params: { campId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in to report an issue' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const type: ReportType = VALID_TYPES.includes(body.type) ? body.type : 'OTHER';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (description.length < 10) {
    return NextResponse.json({ error: 'Please describe the issue (at least 10 characters)' }, { status: 400 });
  }
  if (description.length > 2000) {
    return NextResponse.json({ error: 'Description too long (max 2000 characters)' }, { status: 400 });
  }

  const pool = getPool();

  // Verify camp exists
  const { rows: [camp] } = await pool.query<{ id: string }>(
    `SELECT id FROM "Camp" WHERE id = $1`,
    [params.campId]
  );
  if (!camp) return NextResponse.json({ error: 'Camp not found' }, { status: 404 });

  await pool.query(
    `INSERT INTO "CampReport" ("campId", "userId", "userEmail", type, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.campId, user.id, user.email, type, description]
  );

  return NextResponse.json({ ok: true });
}
