import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { writeChangeLogs } from '@/lib/admin/changelog-repository';
import { bulkAttestCamp } from '@/lib/admin/bulk-attestation';
import { updateAdminCampFields } from '@/lib/admin/camp-repository';

// `dataConfidence`/`lastVerifiedAt` are deliberately excluded: they are
// derived, cache-only columns whose sole writer is
// `lib/admin/verification-authority.ts`'s `refreshCampVerificationCache`
// (AC1's "sole computer" invariant) — allowing either through this
// dynamic-SET PATCH would let an admin flip `dataConfidence` to `VERIFIED`
// with zero backing Claim/Evidence/Event and no cache refresh (security
// review SF1). See `tests/integration/editable-fields.test.ts`.
export const EDITABLE_FIELDS = new Set([
  'name', 'organizationName', 'providerId', 'websiteUrl', 'description', 'notes', 'interestingDetails',
  'campType', 'category', 'campTypes', 'categories', 'registrationStatus', 'registrationOpenDate',
  'lunchIncluded', 'city', 'neighborhood', 'address', 'state', 'zip',
  'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
]);

/** Structural guardrail (V5/SF1): fail loud if either derived column ever reappears here. */
const FORBIDDEN_EDITABLE_FIELDS = ['dataConfidence', 'lastVerifiedAt'] as const;
for (const forbidden of FORBIDDEN_EDITABLE_FIELDS) {
  if (EDITABLE_FIELDS.has(forbidden)) {
    throw new Error(
      `EDITABLE_FIELDS must never include "${forbidden}" — it is a derived column whose sole ` +
        `writer is refreshCampVerificationCache (see this file's EDITABLE_FIELDS comment).`,
    );
  }
}

export async function PATCH(req: Request, props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const updates = Object.entries(body).filter(([k]) => EDITABLE_FIELDS.has(k));
  if (updates.length === 0) return NextResponse.json({ error: 'No valid fields' }, { status: 400 });

  const current = await updateAdminCampFields(params.campId, updates);
  if (!current) return NextResponse.json({ error: 'Camp not found' }, { status: 404 });

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
export async function POST(req: Request, props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { action } = await req.json().catch(() => ({})) as { action?: string };
  if (action !== 'mark_verified') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  const result = await bulkAttestCamp(params.campId, auth.access.email);
  return NextResponse.json({
    ok: true,
    verified: result.dataConfidence === 'VERIFIED',
    dataConfidence: result.dataConfidence,
    attestedFieldCount: result.attestedFieldCount,
    gaps: result.gapRequirementIds,
  });
}
