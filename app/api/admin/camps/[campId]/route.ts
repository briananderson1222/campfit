import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

const EDITABLE_FIELDS = new Set([
  'name', 'organizationName', 'providerId', 'websiteUrl', 'description', 'notes', 'interestingDetails',
  'campType', 'category', 'campTypes', 'categories', 'registrationStatus', 'registrationOpenDate',
  'dataConfidence', 'lunchIncluded', 'city', 'neighborhood', 'address', 'state', 'zip',
]);

export async function PATCH(
  req: Request,
  { params }: { params: { campId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const updates = Object.entries(body).filter(([k]) => EDITABLE_FIELDS.has(k));
  if (updates.length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });

  const setClauses = updates.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [params.campId, ...updates.map(([, v]) => v ?? null)];

  const pool = getPool();
  await pool.query(
    `UPDATE "Camp" SET ${setClauses}, "updatedAt" = NOW() WHERE id = $1`,
    values
  );

  return NextResponse.json({ ok: true });
}

/** Explicit VERIFIED mark — separate from PATCH to enforce intentionality. */
export async function POST(
  req: Request,
  { params }: { params: { campId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { action } = await req.json().catch(() => ({})) as { action?: string };
  if (action !== 'mark_verified') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  const pool = getPool();
  await pool.query(
    `UPDATE "Camp" SET "dataConfidence" = 'VERIFIED', "lastVerifiedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [params.campId]
  );
  return NextResponse.json({ ok: true });
}

