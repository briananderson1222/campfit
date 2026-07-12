import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug, getProviderCommunitySlug } from '@/lib/admin/community-access';
import { getFieldAttestationTarget, updateFieldAttestation } from '@/lib/admin/attestation-repository';

export async function PATCH(request: Request, props: { params: Promise<{ attestationId: string }> }) {
  const params = await props.params;
  const body = await request.json().catch(() => ({})) as {
    action?: 'recheck' | 'mark_stale' | 'invalidate';
    notes?: string | null;
    invalidationReason?: string | null;
  };

  const attestation = await getFieldAttestationTarget(params.attestationId);
  if (!attestation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const communitySlug = attestation.entityType === 'CAMP'
    ? await getCampCommunitySlug(attestation.entityId)
    : attestation.entityType === 'PROVIDER'
      ? await getProviderCommunitySlug(attestation.entityId)
      : null;
  const auth = await requireAdminAccess({ communitySlug, allowModerator: attestation.entityType !== 'PERSON' });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const attestationUpdate = await updateFieldAttestation(
    params.attestationId,
    body.notes?.trim() || null,
    body.action,
    body.invalidationReason,
  );
  return NextResponse.json(attestationUpdate);
}
