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
import { VERIFIED_CAMP_FIELDS } from '@/lib/admin/verification-policy';
import { recordCampAttestationEvidence } from '@/lib/admin/entity-admin-repository';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';

export async function POST(req: Request, props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { fields, notes }: { fields: string[]; notes?: string } = await req.json();
  if (!Array.isArray(fields) || fields.length === 0) {
    return NextResponse.json({ error: 'fields must be a non-empty array' }, { status: 400 });
  }
  if (typeof notes !== 'string' || !notes.trim()) {
    return NextResponse.json({ error: 'notes is required as the override reason' }, { status: 400 });
  }

  // Only allow attestation of Verified Camp Claim Set fields (verification-policy.ts).
  // `schedules` is deliberately NOT attestable here anymore: it was replaced by the
  // `sessions-verified` rollup requirement, which is satisfied by real per-Session
  // claim verification (or archiving all Sessions), not a blanket admin attestation
  // (see Wave 5 step-0 resolution, verification-authority--deliver.md).
  const allowed = new Set<string>(VERIFIED_CAMP_FIELDS);
  const invalid = fields.filter(f => !allowed.has(f));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Fields not attestable: ${invalid.join(', ')}` }, { status: 400 });
  }

  const pool = getPool();
  const now = new Date().toISOString();

  // Reconciled path (this slice's Wave 4 "reconcile behind one recordEvidence
  // interface" decision, verification-authority--deliver-plan.md): records a
  // Claim/Evidence/Event triple per attested field via
  // `recordCampAttestationEvidence` (shared with `addFieldAttestation`'s
  // single-field case, `lib/admin/entity-admin-repository.ts`), then
  // refreshes the cached `Camp.dataConfidence`.
  await recordCampAttestationEvidence({
    campId: params.campId,
    fields,
    actor: auth.access.email,
    attestedAt: now,
    notes,
    mode: 'override',
  });

  // Build a fieldSources patch: one entry per field, attestedBy + approvedAt, no excerpt/sourceUrl
  // KEPT (legacy, rollback path, decision 2) — the ClaimStore write above is
  // additive, never a replacement for this Camp-level audit trail.
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
