/**
 * POST /api/admin/camps/[campId]/attest
 *
 * Admin attestation: explicitly marks one or more required fields as
 * intentionally blank / reviewed, writing a fieldSources entry with
 * approvedAt but no excerpt or sourceUrl. This lets a camp achieve
 * VERIFIED status even when certain fields are intentionally N/A.
 *
 * Body: { fields: string[], notes?: string }
 */

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { REQUIRED_FOR_VERIFIED } from '@/lib/admin/verification';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';

export async function POST(
  req: Request,
  { params }: { params: { campId: string } }
) {
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { fields, notes }: { fields: string[]; notes?: string } = await req.json();
  if (!Array.isArray(fields) || fields.length === 0) {
    return NextResponse.json({ error: 'fields must be a non-empty array' }, { status: 400 });
  }

  // Only allow attestation of REQUIRED_FOR_VERIFIED fields
  const allowed = new Set<string>(REQUIRED_FOR_VERIFIED);
  const invalid = fields.filter(f => !allowed.has(f));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Fields not attestable: ${invalid.join(', ')}` }, { status: 400 });
  }

  const pool = getPool();
  const now = new Date().toISOString();

  // Build a fieldSources patch: one entry per field, attestedBy + approvedAt, no excerpt/sourceUrl
  const patch: Record<string, { excerpt: null; sourceUrl: string; approvedAt: string; attestedBy: string; notes?: string }> = {};
  for (const field of fields) {
    patch[field] = {
      excerpt: null,
      sourceUrl: `admin:${auth.access.email}`,
      approvedAt: now,
      attestedBy: auth.access.email,
      ...(notes ? { notes } : {}),
    };
  }

  await pool.query(
    `UPDATE "Camp"
     SET "fieldSources" = COALESCE("fieldSources", '{}') || $1::jsonb,
         "lastVerifiedAt" = now()
     WHERE id = $2`,
    [JSON.stringify(patch), params.campId]
  );

  return NextResponse.json({ attested: fields, at: now });
}
