import { NextResponse } from 'next/server';
import {
  addCampAccreditation,
  addFieldAttestation,
  createCampProposal,
  createProviderProposal,
  createReviewFlag,
  ensurePerson,
  getEntityContext,
  getEntitySnapshot,
  linkPersonToEntity,
  logAiAction,
  setEntityArchiveState,
  type AdminEntityType,
} from '@/lib/admin/entity-admin-repository';
import { getPool } from '@/lib/db';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug, getProviderCommunitySlug } from '@/lib/admin/community-access';

type AssistantAction =
  | 'get_camp'
  | 'get_provider'
  | 'get_connected_camps'
  | 'get_attestations'
  | 'get_people'
  | 'get_accreditations'
  | 'get_flags'
  | 'propose_camp_changes'
  | 'propose_provider_changes'
  | 'write_camp_update'
  | 'write_provider_update'
  | 'mark_camp_verified'
  | 'trigger_camp_crawl'
  | 'trigger_provider_crawl'
  | 'flag_entity'
  | 'archive_entity'
  | 'restore_entity'
  | 'add_attestation'
  | 'add_person'
  | 'add_accreditation';

function parseEntityType(value: unknown): AdminEntityType | null {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  if (upper === 'CAMP' || upper === 'PROVIDER' || upper === 'PERSON') return upper;
  return null;
}

function capabilityFor(action: AssistantAction) {
  if (action.startsWith('get_')) return 'READ' as const;
  if (action.startsWith('propose_')) return 'PROPOSE' as const;
  return 'WRITE' as const;
}

const CAMP_UPDATE_FIELDS = new Set([
  'name', 'organizationName', 'providerId', 'websiteUrl', 'description', 'notes',
  'interestingDetails', 'campType', 'category', 'campTypes', 'categories',
  'registrationStatus', 'registrationOpenDate', 'dataConfidence', 'lunchIncluded',
  'city', 'neighborhood', 'address', 'state', 'zip', 'applicationUrl',
  'contactEmail', 'contactPhone', 'socialLinks',
]);

const PROVIDER_UPDATE_FIELDS = new Set([
  'name', 'websiteUrl', 'logoUrl', 'address', 'city', 'neighborhood',
  'contactEmail', 'contactPhone', 'notes', 'crawlRootUrl', 'applicationUrl', 'socialLinks',
]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    action?: AssistantAction;
    entityType?: string;
    entityId?: string;
    payload?: Record<string, unknown>;
    confirmed?: boolean;
  } | null;
  if (!body?.action) return NextResponse.json({ error: 'action is required' }, { status: 400 });

  const entityType = parseEntityType(body.entityType ?? null);
  const entityId = body.entityId ?? null;
  const communitySlug = entityType === 'CAMP' && entityId
    ? await getCampCommunitySlug(entityId)
    : entityType === 'PROVIDER' && entityId
      ? await getProviderCommunitySlug(entityId)
      : null;
  const auth = await requireAdminAccess({ communitySlug, allowModerator: entityType !== 'PERSON' });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const capability = capabilityFor(body.action);
  const requiresConfirmation = capability !== 'READ';
  const payload = body.payload ?? {};

  if (requiresConfirmation && !body.confirmed) {
    const log = await logAiAction({
      capability,
      action: body.action,
      entityType,
      entityId,
      requestedBy: auth.access.email,
      requiresConfirmation: true,
      input: payload,
      status: 'REQUESTED',
    });
    return NextResponse.json({
      requiresConfirmation: true,
      actionLogId: log.id,
      capability,
      message: `${body.action} requires admin confirmation before it can mutate data.`,
    });
  }

  try {
    let output: unknown;
    switch (body.action) {
      case 'get_camp':
        if (entityType !== 'CAMP' || !entityId) return NextResponse.json({ error: 'CAMP entityId required' }, { status: 400 });
        output = await getEntityContext('CAMP', entityId);
        break;
      case 'get_provider':
        if (entityType !== 'PROVIDER' || !entityId) return NextResponse.json({ error: 'PROVIDER entityId required' }, { status: 400 });
        output = await getEntityContext('PROVIDER', entityId);
        break;
      case 'get_connected_camps': {
        if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 });
        const pool = getPool();
        const providerId = entityType === 'PROVIDER'
          ? entityId
          : (await pool.query(`SELECT "providerId" FROM "Camp" WHERE id = $1`, [entityId])).rows[0]?.providerId;
        if (!providerId) {
          output = [];
        } else {
          output = (await pool.query(
            `SELECT id, name, slug, city, state, "lastVerifiedAt"
             FROM "Camp"
             WHERE "providerId" = $1
             ORDER BY name ASC`,
            [providerId],
          )).rows;
        }
        break;
      }
      case 'get_attestations':
      case 'get_people':
      case 'get_accreditations':
      case 'get_flags':
        if (!entityType || !entityId) return NextResponse.json({ error: 'entityType and entityId required' }, { status: 400 });
        output = await getEntityContext(entityType, entityId);
        break;
      case 'propose_camp_changes':
        if (entityType !== 'CAMP' || !entityId) return NextResponse.json({ error: 'CAMP entityId required' }, { status: 400 });
        if (!payload.proposedChanges || typeof payload.proposedChanges !== 'object') {
          return NextResponse.json({ error: 'payload.proposedChanges is required' }, { status: 400 });
        }
        output = await createCampProposal({
          campId: entityId,
          sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : 'admin:assistant',
          proposedChanges: payload.proposedChanges as Record<string, unknown>,
          actor: auth.access.email,
          reviewerNotes: typeof payload.reviewerNotes === 'string' ? payload.reviewerNotes : null,
        });
        break;
      case 'propose_provider_changes':
        if (entityType !== 'PROVIDER' || !entityId) return NextResponse.json({ error: 'PROVIDER entityId required' }, { status: 400 });
        if (!payload.proposedChanges || typeof payload.proposedChanges !== 'object') {
          return NextResponse.json({ error: 'payload.proposedChanges is required' }, { status: 400 });
        }
        output = await createProviderProposal({
          providerId: entityId,
          sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : 'admin:assistant',
          proposedChanges: payload.proposedChanges as Record<string, unknown>,
          actor: auth.access.email,
          reviewerNotes: typeof payload.reviewerNotes === 'string' ? payload.reviewerNotes : null,
        });
        break;
      case 'write_camp_update': {
        if (entityType !== 'CAMP' || !entityId) return NextResponse.json({ error: 'CAMP entityId required' }, { status: 400 });
        if (!payload.updates || typeof payload.updates !== 'object') return NextResponse.json({ error: 'payload.updates is required' }, { status: 400 });
        const updates = Object.fromEntries(Object.entries(payload.updates as Record<string, unknown>).filter(([key]) => CAMP_UPDATE_FIELDS.has(key)));
        const entries = Object.entries(updates);
        if (entries.length === 0) return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
        const setClauses = entries.map(([key], index) => `"${key}" = $${index + 2}`).join(', ');
        await getPool().query(`UPDATE "Camp" SET ${setClauses}, "updatedAt" = now() WHERE id = $1`, [entityId, ...entries.map(([, value]) => value ?? null)]);
        output = await getEntitySnapshot('CAMP', entityId);
        break;
      }
      case 'write_provider_update': {
        if (entityType !== 'PROVIDER' || !entityId) return NextResponse.json({ error: 'PROVIDER entityId required' }, { status: 400 });
        if (!payload.updates || typeof payload.updates !== 'object') return NextResponse.json({ error: 'payload.updates is required' }, { status: 400 });
        const updates = Object.fromEntries(Object.entries(payload.updates as Record<string, unknown>).filter(([key]) => PROVIDER_UPDATE_FIELDS.has(key)));
        const entries = Object.entries(updates);
        if (entries.length === 0) return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
        const setClauses = entries.map(([key], index) => `"${key}" = $${index + 2}`).join(', ');
        await getPool().query(`UPDATE "Provider" SET ${setClauses}, "updatedAt" = now() WHERE id = $1`, [entityId, ...entries.map(([, value]) => value ?? null)]);
        output = await getEntitySnapshot('PROVIDER', entityId);
        break;
      }
      case 'mark_camp_verified':
        if (entityType !== 'CAMP' || !entityId) return NextResponse.json({ error: 'CAMP entityId required' }, { status: 400 });
        await getPool().query(`UPDATE "Camp" SET "dataConfidence" = 'VERIFIED', "lastVerifiedAt" = now(), "updatedAt" = now() WHERE id = $1`, [entityId]);
        output = await getEntitySnapshot('CAMP', entityId);
        break;
      case 'trigger_camp_crawl':
        if (entityType !== 'CAMP' || !entityId) return NextResponse.json({ error: 'CAMP entityId required' }, { status: 400 });
        output = await startCampCrawl(entityId, auth.access.email);
        break;
      case 'trigger_provider_crawl':
        if (entityType !== 'PROVIDER' || !entityId) return NextResponse.json({ error: 'PROVIDER entityId required' }, { status: 400 });
        output = await startProviderCrawl(entityId, auth.access.email);
        break;
      case 'flag_entity':
        if (!entityType || !entityId) return NextResponse.json({ error: 'entityType and entityId required' }, { status: 400 });
        if (typeof payload.comment !== 'string' || !payload.comment.trim()) {
          return NextResponse.json({ error: 'payload.comment is required' }, { status: 400 });
        }
        output = await createReviewFlag({
          entityType,
          entityId,
          comment: payload.comment,
          actor: auth.access.email,
        });
        break;
      case 'archive_entity':
        if (!entityType || !entityId) return NextResponse.json({ error: 'entityType and entityId required' }, { status: 400 });
        await setEntityArchiveState({
          entityType,
          entityId,
          archive: true,
          actor: auth.access.email,
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        });
        output = await getEntitySnapshot(entityType, entityId);
        break;
      case 'restore_entity':
        if (!entityType || !entityId) return NextResponse.json({ error: 'entityType and entityId required' }, { status: 400 });
        await setEntityArchiveState({
          entityType,
          entityId,
          archive: false,
          actor: auth.access.email,
        });
        output = await getEntitySnapshot(entityType, entityId);
        break;
      case 'add_attestation':
        if (!entityType || !entityId) return NextResponse.json({ error: 'entityType and entityId required' }, { status: 400 });
        if (typeof payload.fieldKey !== 'string' || !payload.fieldKey.trim()) {
          return NextResponse.json({ error: 'payload.fieldKey is required' }, { status: 400 });
        }
        output = await addFieldAttestation({
          entityType,
          entityId,
          fieldKey: payload.fieldKey,
          actor: auth.access.email,
          sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : null,
          excerpt: typeof payload.excerpt === 'string' ? payload.excerpt : null,
          notes: typeof payload.notes === 'string' ? payload.notes : null,
          valueSnapshot: payload.valueSnapshot,
        });
        break;
      case 'add_person':
        if ((entityType !== 'CAMP' && entityType !== 'PROVIDER') || !entityId) {
          return NextResponse.json({ error: 'CAMP or PROVIDER entityId required' }, { status: 400 });
        }
        if (typeof payload.fullName !== 'string' || !payload.fullName.trim()) {
          return NextResponse.json({ error: 'payload.fullName is required' }, { status: 400 });
        }
        output = await (async () => {
          const person = await ensurePerson({
            fullName: payload.fullName as string,
            contactMethods: Array.isArray(payload.contactMethods)
              ? payload.contactMethods.filter((item): item is { type: string; value: string; label?: string | null } =>
                  !!item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string' && typeof (item as { value?: unknown }).value === 'string')
              : [],
          });
          const link = await linkPersonToEntity({
            entityType,
            entityId,
            personId: person.id,
            actor: auth.access.email,
            title: typeof payload.title === 'string' ? payload.title : null,
            roleType: typeof payload.roleType === 'string' ? payload.roleType : null,
            notes: typeof payload.notes === 'string' ? payload.notes : null,
            sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : null,
            excerpt: typeof payload.excerpt === 'string' ? payload.excerpt : null,
          });
          return { person, link };
        })();
        break;
      case 'add_accreditation':
        if (entityType !== 'CAMP' || !entityId) return NextResponse.json({ error: 'CAMP entityId required' }, { status: 400 });
        if (typeof payload.bodyName !== 'string' || !payload.bodyName.trim()) {
          return NextResponse.json({ error: 'payload.bodyName is required' }, { status: 400 });
        }
        output = await addCampAccreditation({
          campId: entityId,
          bodyName: payload.bodyName,
          actor: auth.access.email,
          status: typeof payload.status === 'string' ? payload.status : null,
          scope: typeof payload.scope === 'string' ? payload.scope : null,
          sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl : null,
          excerpt: typeof payload.excerpt === 'string' ? payload.excerpt : null,
          notes: typeof payload.notes === 'string' ? payload.notes : null,
        });
        break;
      default:
        return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
    }

    const log = await logAiAction({
      capability,
      action: body.action,
      entityType,
      entityId,
      requestedBy: auth.access.email,
      requiresConfirmation,
      input: payload,
      output,
      status: 'COMPLETED',
    });

    return NextResponse.json({ ok: true, capability, output, actionLogId: log.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action failed';
    await logAiAction({
      capability,
      action: body.action,
      entityType,
      entityId,
      requestedBy: auth.access.email,
      requiresConfirmation,
      input: payload,
      error: message,
      status: 'FAILED',
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function startCampCrawl(campId: string, actor: string) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; websiteUrl: string | null }>(
    `SELECT id, "websiteUrl" FROM "Camp" WHERE id = $1`,
    [campId],
  );
  if (rows.length === 0) throw new Error('Camp not found');
  if (!rows[0].websiteUrl) throw new Error('Camp has no websiteUrl to crawl');

  await pool.query(
    `UPDATE "CampChangeProposal" SET status = 'SKIPPED'
     WHERE "campId" = $1 AND status = 'PENDING'`,
    [campId],
  );

  return startPipeline({ triggeredBy: actor, campIds: [campId] });
}

async function startProviderCrawl(providerId: string, actor: string) {
  const pool = getPool();
  const [providerRes, campsRes] = await Promise.all([
    pool.query<{ crawlRootUrl: string | null; websiteUrl: string | null }>(
      `SELECT "crawlRootUrl", "websiteUrl" FROM "Provider" WHERE id = $1`,
      [providerId],
    ),
    pool.query<{ id: string }>(
      `SELECT id FROM "Camp" WHERE "providerId" = $1 AND "websiteUrl" IS NOT NULL AND "websiteUrl" != '' AND "archivedAt" IS NULL`,
      [providerId],
    ),
  ]);

  const campIds = campsRes.rows.map((row) => row.id);
  if (campIds.length === 0 && !providerRes.rows[0]?.crawlRootUrl && !providerRes.rows[0]?.websiteUrl) {
    throw new Error('No crawlable camps or provider root URL');
  }

  return startPipeline({ triggeredBy: actor, providerIds: [providerId] });
}

async function startPipeline(opts: { triggeredBy: string; campIds?: string[]; providerIds?: string[] }) {
  let resolveRunId!: (id: string) => void;
  let rejectRunId!: (err: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve;
    rejectRunId = reject;
  });

  runCrawlPipeline({
    triggeredBy: opts.triggeredBy,
    trigger: 'MANUAL',
    campIds: opts.campIds,
    providerIds: opts.providerIds,
    onProgress: (event) => {
      if (event.type === 'started') resolveRunId(event.runId);
    },
  }).catch((err) => {
    rejectRunId(err instanceof Error ? err : new Error(String(err)));
  });

  const runId = await Promise.race([
    runIdPromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for crawl to start')), 5000),
    ),
  ]);
  return { runId };
}
