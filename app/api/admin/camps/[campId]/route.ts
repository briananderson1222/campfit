import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { writeChangeLogs } from '@/lib/admin/changelog-repository';

const EDITABLE_FIELDS = new Set([
  'name', 'organizationName', 'providerId', 'websiteUrl', 'description', 'notes', 'interestingDetails',
  'campType', 'category', 'campTypes', 'categories', 'registrationStatus', 'registrationOpenDate',
  'dataConfidence', 'lunchIncluded', 'city', 'neighborhood', 'address', 'state', 'zip',
  'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
]);

export async function PATCH(
  req: Request,
  { params }: { params: { campId: string } }
) {
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const updates = Object.entries(body).filter(([k]) => EDITABLE_FIELDS.has(k));
  if (updates.length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });

  const pool = getPool();
  const { rows: currentRows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM "Camp" WHERE id = $1`,
    [params.campId],
  );
  const current = currentRows[0];
  if (!current) return NextResponse.json({ error: 'Camp not found' }, { status: 404 });

  const setClauses = updates.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [params.campId, ...updates.map(([, v]) => v ?? null)];
  await pool.query(`UPDATE "Camp" SET ${setClauses}, "updatedAt" = NOW() WHERE id = $1`, values);

  await writeChangeLogs(
    updates.map(([field, newValue]) => ({
      campId: params.campId,
      proposalId: null,
      changedBy: auth.access.email,
      fieldName: field,
      oldValue: current[field] ?? null,
      newValue: newValue ?? null,
      changeType: current[field] === null || current[field] === '' ? 'FIELD_POPULATED' : 'UPDATE',
    })),
  ).catch((error) => {
    console.error('[camp PATCH] writeChangeLogs failed:', error);
  });

  return NextResponse.json({ ok: true });
}

/** Explicit VERIFIED mark — separate from PATCH to enforce intentionality. */
export async function POST(
  req: Request,
  { params }: { params: { campId: string } }
) {
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { action } = await req.json().catch(() => ({})) as { action?: string };
  if (action !== 'mark_verified') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  const pool = getPool();
  await pool.query(
    `UPDATE "Camp" SET "dataConfidence" = 'VERIFIED', "lastVerifiedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    [params.campId]
  );
  return NextResponse.json({ ok: true });
}
