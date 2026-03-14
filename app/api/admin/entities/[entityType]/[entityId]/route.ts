import { NextResponse } from 'next/server';
import {
  addCampAccreditation,
  addFieldAttestation,
  createReviewFlag,
  ensurePerson,
  getEntityContext,
  getEntityRelatedCamps,
  linkPersonToEntity,
  setEntityArchiveState,
  type AdminEntityType,
} from '@/lib/admin/entity-admin-repository';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug, getProviderCommunitySlug } from '@/lib/admin/community-access';

function parseEntityType(value: string): AdminEntityType | null {
  const upper = value.toUpperCase();
  if (upper === 'CAMP' || upper === 'PROVIDER' || upper === 'PERSON') return upper;
  return null;
}

const ENTITY_ATTESTATION_FIELDS: Record<AdminEntityType, string[]> = {
  CAMP: [
    'name',
    'organizationName',
    'description',
    'websiteUrl',
    'applicationUrl',
    'contactEmail',
    'contactPhone',
    'socialLinks',
    'interestingDetails',
    'city',
    'state',
    'zip',
    'neighborhood',
    'address',
    'lunchIncluded',
    'registrationStatus',
    'registrationOpenDate',
    'registrationCloseDate',
    'campTypes',
    'categories',
    'ageGroups',
    'schedules',
    'pricing',
    'provider',
  ],
  PROVIDER: [
    'name',
    'websiteUrl',
    'applicationUrl',
    'contactEmail',
    'contactPhone',
    'socialLinks',
    'city',
    'neighborhood',
    'address',
    'notes',
    'crawlRootUrl',
    'people',
    'accreditation',
  ],
  PERSON: [
    'fullName',
    'bio',
    'contacts',
  ],
};

function isAllowedAttestationField(entityType: AdminEntityType, fieldKey: string) {
  if (ENTITY_ATTESTATION_FIELDS[entityType].includes(fieldKey)) return true;
  if (entityType === 'CAMP') {
    return fieldKey.startsWith('ageGroups:') || fieldKey.startsWith('schedules:') || fieldKey.startsWith('pricing:');
  }
  return false;
}

export async function GET(
  request: Request,
  { params }: { params: { entityType: string; entityId: string } },
) {
  const entityType = parseEntityType(params.entityType);
  if (!entityType) return NextResponse.json({ error: 'Invalid entityType' }, { status: 400 });
  const communitySlug = entityType === 'CAMP'
    ? await getCampCommunitySlug(params.entityId)
    : entityType === 'PROVIDER'
      ? await getProviderCommunitySlug(params.entityId)
      : null;
  const auth = await requireAdminAccess({ communitySlug, allowModerator: entityType !== 'PERSON' });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { searchParams } = new URL(request.url);
  if (searchParams.get('include') === 'related-camps') {
    if (entityType !== 'CAMP' && entityType !== 'PROVIDER') {
      return NextResponse.json({ error: 'Related camps are only available for camps and providers' }, { status: 400 });
    }
    return NextResponse.json({
      relatedCamps: await getEntityRelatedCamps(entityType, params.entityId),
    });
  }

  const context = await getEntityContext(entityType, params.entityId);
  if (!context) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(context);
}

export async function POST(
  request: Request,
  { params }: { params: { entityType: string; entityId: string } },
) {
  const entityType = parseEntityType(params.entityType);
  if (!entityType) return NextResponse.json({ error: 'Invalid entityType' }, { status: 400 });
  const communitySlug = entityType === 'CAMP'
    ? await getCampCommunitySlug(params.entityId)
    : entityType === 'PROVIDER'
      ? await getProviderCommunitySlug(params.entityId)
      : null;
  const auth = await requireAdminAccess({ communitySlug, allowModerator: entityType !== 'PERSON' });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    switch (action) {
      case 'archive':
        await setEntityArchiveState({
          entityType,
          entityId: params.entityId,
          archive: true,
          actor: auth.access.email,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        return NextResponse.json({ ok: true });
      case 'unarchive':
        await setEntityArchiveState({
          entityType,
          entityId: params.entityId,
          archive: false,
          actor: auth.access.email,
        });
        return NextResponse.json({ ok: true });
      case 'flag':
        if (typeof body.comment !== 'string' || !body.comment.trim()) {
          return NextResponse.json({ error: 'comment is required' }, { status: 400 });
        }
        return NextResponse.json(await createReviewFlag({
          entityType,
          entityId: params.entityId,
          comment: body.comment,
          actor: auth.access.email,
        }), { status: 201 });
      case 'attest':
        if (typeof body.fieldKey !== 'string' || !body.fieldKey.trim()) {
          return NextResponse.json({ error: 'fieldKey is required' }, { status: 400 });
        }
        if (!isAllowedAttestationField(entityType, body.fieldKey)) {
          return NextResponse.json({ error: 'fieldKey must be a known attestation target' }, { status: 400 });
        }
        if (body.mode !== 'source' && body.mode !== 'override') {
          return NextResponse.json({ error: 'mode must be source or override' }, { status: 400 });
        }
        if (body.mode === 'source') {
          if (typeof body.sourceUrl !== 'string' || !body.sourceUrl.trim()) {
            return NextResponse.json({ error: 'sourceUrl is required for source attestations' }, { status: 400 });
          }
          if (typeof body.excerpt !== 'string' || !body.excerpt.trim()) {
            return NextResponse.json({ error: 'excerpt is required for source attestations' }, { status: 400 });
          }
        }
        if (body.mode === 'override' && (typeof body.notes !== 'string' || !body.notes.trim())) {
          return NextResponse.json({ error: 'override reason is required for override attestations' }, { status: 400 });
        }
        return NextResponse.json(await addFieldAttestation({
          entityType,
          entityId: params.entityId,
          fieldKey: body.fieldKey,
          actor: auth.access.email,
          mode: body.mode,
          sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : null,
          excerpt: typeof body.excerpt === 'string' ? body.excerpt : null,
          notes: typeof body.notes === 'string' ? body.notes : null,
          valueSnapshot: body.valueSnapshot,
        }), { status: 201 });
      case 'add_person': {
        if (entityType !== 'CAMP' && entityType !== 'PROVIDER') {
          return NextResponse.json({ error: 'People links are only supported for camp/provider' }, { status: 400 });
        }
        if (typeof body.fullName !== 'string' || !body.fullName.trim()) {
          return NextResponse.json({ error: 'fullName is required' }, { status: 400 });
        }
        const person = await ensurePerson({
          fullName: body.fullName,
          contactMethods: Array.isArray(body.contactMethods)
            ? body.contactMethods.filter((item): item is { type: string; value: string; label?: string | null } =>
                !!item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string' && typeof (item as { value?: unknown }).value === 'string')
            : [],
        });
        const link = await linkPersonToEntity({
          entityType,
          entityId: params.entityId,
          personId: person.id,
          actor: auth.access.email,
          title: typeof body.title === 'string' ? body.title : null,
          roleType: typeof body.roleType === 'string' ? body.roleType : null,
          notes: typeof body.notes === 'string' ? body.notes : null,
          sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : null,
          excerpt: typeof body.excerpt === 'string' ? body.excerpt : null,
        });
        return NextResponse.json({ person, link }, { status: 201 });
      }
      case 'add_accreditation':
        if (entityType !== 'CAMP') {
          return NextResponse.json({ error: 'Accreditation is currently camp-only' }, { status: 400 });
        }
        if (typeof body.bodyName !== 'string' || !body.bodyName.trim()) {
          return NextResponse.json({ error: 'bodyName is required' }, { status: 400 });
        }
        return NextResponse.json(await addCampAccreditation({
          campId: params.entityId,
          bodyName: body.bodyName,
          actor: auth.access.email,
          status: typeof body.status === 'string' ? body.status : null,
          scope: typeof body.scope === 'string' ? body.scope : null,
          sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : null,
          excerpt: typeof body.excerpt === 'string' ? body.excerpt : null,
          notes: typeof body.notes === 'string' ? body.notes : null,
        }), { status: 201 });
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 500 });
  }
}
