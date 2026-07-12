import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import type { FieldDiff } from '@/lib/admin/types';
import { writeProviderChangeLogs } from '@/lib/admin/changelog-repository';
import {
  applyProviderProposalFields,
  getProviderProposalForApproval,
  getProviderRecordForProposal,
  markProviderProposalApproved,
} from '@/lib/admin/provider-repository';

const ALLOWED_FIELDS = new Set([
  'name', 'websiteUrl', 'logoUrl', 'address', 'city', 'neighborhood',
  'contactEmail', 'contactPhone', 'notes', 'crawlRootUrl', 'applicationUrl', 'socialLinks',
]);

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const proposal = await getProviderProposalForApproval(params.id);
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireAdminAccess({ communitySlug: proposal.communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Already reviewed' }, { status: 409 });

  const body = await request.json().catch(() => ({})) as {
    approvedFields?: string[];
    reviewerNotes?: string;
    overrides?: Record<string, FieldDiff>;
  };
  const changes = (body.overrides ?? proposal.proposedChanges ?? {}) as Record<string, FieldDiff | unknown>;
  const approved = new Set(
    (body.approvedFields?.length ? body.approvedFields : Object.keys(changes))
      .filter((field) => ALLOWED_FIELDS.has(field)),
  );
  const entries = Object.entries(changes).filter(([key]) => approved.has(key));
  if (entries.length === 0) {
    return NextResponse.json({ error: 'No approved fields provided' }, { status: 400 });
  }

  const currentProvider = await getProviderRecordForProposal(proposal.providerId);

  if (entries.length > 0) {
    await applyProviderProposalFields(proposal.providerId, entries);
  }

  await markProviderProposalApproved(params.id, auth.access.email, body.reviewerNotes?.trim() || null);

  await writeProviderChangeLogs(
    entries.map(([field, value]) => {
      const diff = value as { new?: unknown };
      const nextValue = diff?.new ?? value ?? null;
      return {
        providerId: proposal.providerId,
        changedBy: auth.access.email,
        fieldName: field,
        oldValue: currentProvider?.[field] ?? null,
        newValue: nextValue,
        changeType: currentProvider?.[field] == null ? 'FIELD_POPULATED' as const : 'UPDATE' as const,
      };
    }),
  ).catch((error) => {
    console.error('[provider proposal approve] writeProviderChangeLogs failed:', error);
  });

  return NextResponse.json({ ok: true });
}
