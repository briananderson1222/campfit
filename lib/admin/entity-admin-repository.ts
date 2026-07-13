import { getPool } from '@/lib/db';
import type { PoolClient } from 'pg';
import { buildCampAttestationTrustInput } from './trust-projection';
import { refreshCampVerificationCache } from './verification-authority';
import { acquireSubjectAdvisoryLock, recordEvidenceOnLockedClient } from './claim-store';
import { VERIFIED_CAMP_FIELDS } from './verification-policy';
import { buildSnapshotSourceRef, parseSnapshotSourceRef } from '@kontourai/traverse/fetch';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';
import { parseCharsLocator, resolveReviewExcerpt } from './review-excerpt-resolution';

export type AdminEntityType = 'CAMP' | 'PROVIDER' | 'PERSON';
export type AiCapability = 'READ' | 'PROPOSE' | 'WRITE';
export type AiActionStatus = 'REQUESTED' | 'CONFIRMED' | 'REJECTED' | 'COMPLETED' | 'FAILED';

export async function deletePersonRole(roleType: 'camp' | 'provider', roleId: string): Promise<number | null> {
  const table = roleType === 'camp' ? 'CampPersonRole' : 'ProviderPersonRole';
  const { rowCount } = await getPool().query(
    `DELETE FROM "${table}" WHERE id = $1`,
    [roleId],
  );
  return rowCount;
}

type EntityRow = {
  id: string;
  name?: string | null;
  fullName?: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  lastVerifiedAt?: string | null;
};

export async function getEntitySnapshot(entityType: AdminEntityType, entityId: string) {
  const pool = getPool();
  if (entityType === 'CAMP') {
    const { rows } = await pool.query<EntityRow>(`SELECT id, name, "archivedAt", "archivedBy", "archiveReason", "lastVerifiedAt" FROM "Camp" WHERE id = $1`, [entityId]);
    return rows[0] ?? null;
  }
  if (entityType === 'PROVIDER') {
    const { rows } = await pool.query<EntityRow>(`SELECT id, name, "archivedAt", "archivedBy", "archiveReason", "lastVerifiedAt" FROM "Provider" WHERE id = $1`, [entityId]);
    return rows[0] ?? null;
  }
  const { rows } = await pool.query<EntityRow>(`SELECT id, "fullName", NULL::timestamptz as "archivedAt", NULL::text as "archivedBy", NULL::text as "archiveReason", NULL::timestamptz as "lastVerifiedAt" FROM "Person" WHERE id = $1`, [entityId]);
  return rows[0] ?? null;
}

export async function getEntityContext(entityType: AdminEntityType, entityId: string) {
  const pool = getPool();
  const snapshot = await getEntitySnapshot(entityType, entityId);
  if (!snapshot) return null;

  const [flags, attestations, aiActions, people, accreditations] = await Promise.all([
    pool.query(
      `SELECT * FROM "ReviewFlag"
       WHERE "entityType" = $1 AND "entityId" = $2
       ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, "createdAt" DESC`,
      [entityType, entityId],
    ),
    pool.query(
      `SELECT * FROM "FieldAttestation"
       WHERE "entityType" = $1 AND "entityId" = $2
       ORDER BY "createdAt" DESC
       LIMIT 50`,
      [entityType, entityId],
    ),
    pool.query(
      `SELECT id, capability, action, status, "requiresConfirmation", input, output, error, "createdAt", "completedAt"
       FROM "AiActionLog"
       WHERE "entityType" = $1 AND "entityId" = $2
       ORDER BY "createdAt" DESC
       LIMIT 20`,
      [entityType, entityId],
    ),
    entityType === 'CAMP'
      ? pool.query(
          `SELECT p.id, r.id AS "roleId", r.title, r."roleType", r.notes, r."approvedAt", p.id AS "personId", p."fullName",
                  COALESCE(json_agg(json_build_object('id', pcm.id, 'type', pcm.type, 'value', pcm.value, 'label', pcm.label))
                    FILTER (WHERE pcm.id IS NOT NULL), '[]'::json) AS contacts
           FROM "CampPersonRole" r
           JOIN "Person" p ON p.id = r."personId"
           LEFT JOIN "PersonContactMethod" pcm ON pcm."personId" = p.id
           WHERE r."campId" = $1
           GROUP BY r.id, p.id
           ORDER BY p."fullName" ASC`,
          [entityId],
        )
      : entityType === 'PROVIDER'
        ? pool.query(
            `SELECT p.id, r.id AS "roleId", r.title, r."roleType", r.notes, r."approvedAt", p.id AS "personId", p."fullName",
                    COALESCE(json_agg(json_build_object('id', pcm.id, 'type', pcm.type, 'value', pcm.value, 'label', pcm.label))
                      FILTER (WHERE pcm.id IS NOT NULL), '[]'::json) AS contacts
             FROM "ProviderPersonRole" r
             JOIN "Person" p ON p.id = r."personId"
             LEFT JOIN "PersonContactMethod" pcm ON pcm."personId" = p.id
             WHERE r."providerId" = $1
             GROUP BY r.id, p.id
             ORDER BY p."fullName" ASC`,
            [entityId],
          )
        : pool.query(`SELECT id, "fullName" FROM "Person" WHERE id = $1`, [entityId]),
    entityType === 'CAMP'
      ? pool.query(
          `SELECT ca.*, ab.name AS "bodyName", ab.slug AS "bodySlug"
           FROM "CampAccreditation" ca
           JOIN "AccreditationBody" ab ON ab.id = ca."bodyId"
           WHERE ca."campId" = $1
           ORDER BY ab.name ASC`,
          [entityId],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    snapshot,
    flags: flags.rows,
    attestations: attestations.rows,
    aiActions: aiActions.rows,
    people: people.rows,
    accreditations: accreditations.rows,
  };
}

export async function getEntityRelatedCamps(entityType: Extract<AdminEntityType, 'CAMP' | 'PROVIDER'>, entityId: string) {
  const pool = getPool();
  const providerId = entityType === 'PROVIDER'
    ? entityId
    : (await pool.query<{ providerId: string | null }>(`SELECT "providerId" FROM "Camp" WHERE id = $1`, [entityId])).rows[0]?.providerId;

  if (!providerId) return [];

  const { rows } = await pool.query(
    `SELECT id, name, slug, city, state, "lastVerifiedAt"
     FROM "Camp"
     WHERE "providerId" = $1
     ORDER BY name ASC`,
    [providerId],
  );
  return rows;
}

export async function setEntityArchiveState(opts: {
  entityType: AdminEntityType;
  entityId: string;
  archive: boolean;
  actor: string;
  reason?: string;
}) {
  const pool = getPool();
  const table = opts.entityType === 'CAMP' ? 'Camp' : opts.entityType === 'PROVIDER' ? 'Provider' : null;
  if (!table) throw new Error(`Archiving not supported for ${opts.entityType}`);

  await pool.query(
    `UPDATE "${table}"
     SET "archivedAt" = ${opts.archive ? 'now()' : 'NULL'},
         "archivedBy" = $2,
         "archiveReason" = $3,
         "updatedAt" = now()
     WHERE id = $1`,
    [opts.entityId, opts.actor, opts.archive ? opts.reason ?? null : null],
  );
}

export async function createReviewFlag(opts: {
  entityType: AdminEntityType;
  entityId: string;
  comment: string;
  actor: string;
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "ReviewFlag" ("entityType", "entityId", comment, "createdBy")
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [opts.entityType, opts.entityId, opts.comment, opts.actor],
  );
  return rows[0];
}

/**
 * The `VERIFIED_CAMP_FIELDS` set (`verification-policy.ts`'s Verified Camp
 * Claim Set field vocabulary), widened to `readonly string[]` so an arbitrary
 * `fieldKey: string` (e.g. `addFieldAttestation`'s free-form attestation
 * target, which also accepts non-claim-set fields like `organizationName`,
 * and indexed sub-fields like `ageGroups:0`) can be checked against it
 * without a type error. Exact-match only: an indexed sub-field key does NOT
 * match its parent field name, matching this task's plan wording literally
 * ("fieldKey in VERIFIED_CAMP_CLAIM_SET").
 */
const VERIFIED_CAMP_CLAIM_SET_FIELDS: readonly string[] = VERIFIED_CAMP_FIELDS;
const MAX_SOURCE_REF_LENGTH = 4096;
const MAX_EXCERPT_LENGTH = 100_000;
const MAX_REASON_LENGTH = 10_000;
const MAX_LOCATOR_LENGTH = 128;

/**
 * The one place both legacy attestation stores (the `/attest` bulk route's
 * `fieldSources` JSON patch and `addFieldAttestation`'s `FieldAttestation`
 * row) reconcile behind `claim-store.ts`'s `recordEvidence` interface (this
 * slice's Wave 4 decision — see `verification-authority--deliver-plan.md`'s
 * "reconcile behind one recordEvidence interface" narrative). Builds a
 * `TrustBundle` for the given Camp field(s) via `trust-projection.ts`'s
 * `buildCampAttestationTrustInput` (one Claim + Evidence + Event per field,
 * 1:1 by construction — see `@kontourai/survey`'s `buildSurveyTrustBundle`),
 * records each triple, then refreshes `Camp.dataConfidence` once for the
 * whole batch. Exported so `app/api/admin/camps/[campId]/attest/route.ts`
 * (the bulk multi-field caller) and `addFieldAttestation` below (the
 * single-field caller) share the exact same reconciliation logic instead of
 * maintaining two copies of it.
 */
export async function recordCampAttestationEvidence(args: {
  campId: string;
  fields: string[];
  actor: string;
  attestedAt: string;
  notes?: string | null;
  values?: Record<string, unknown>;
  mode: 'source' | 'override';
  sourceRef?: string;
  sourceLocator?: string;
  excerpt?: string;
  legacyWrite?: (client: PoolClient) => Promise<unknown>;
  reconcileRefreshFailure?: boolean;
}): Promise<unknown> {
  validateCampAttestationEvidenceInput(args);
  const pool = getPool();
  const trustBundle = buildCampAttestationTrustInput({
    campId: args.campId,
    fields: args.fields,
    actor: args.actor,
    attestedAt: args.attestedAt,
    notes: args.notes,
    values: args.values,
    mode: args.mode,
    sourceRef: args.sourceRef,
    sourceLocator: args.sourceLocator,
    excerpt: args.excerpt,
  });
  const firstClaim = trustBundle.claims[0];
  if (!firstClaim) throw new AttestationValidationError('At least one attestation field is required.');
  if (trustBundle.claims.some((claim) => claim.subjectType !== firstClaim.subjectType || claim.subjectId !== firstClaim.subjectId)) {
    throw new Error('Camp attestation bundle spans more than one Claim subject.');
  }
  const client = await pool.connect();
  let legacyResult: unknown;
  try {
    await client.query('BEGIN');
    await acquireSubjectAdvisoryLock(client, firstClaim.subjectType, firstClaim.subjectId);
    for (const claim of trustBundle.claims) {
      const evidence = trustBundle.evidence.find((item) => item.claimId === claim.id);
      if (!evidence) throw new Error(`Missing attestation Evidence for Claim "${claim.id}".`);
      const event = trustBundle.events.find((item) => item.claimId === claim.id);
      await recordEvidenceOnLockedClient(pool, client, { claim, evidence, event });
    }
    if (args.legacyWrite) legacyResult = await args.legacyWrite(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  try {
    await refreshCampVerificationCache(args.campId);
  } catch (error) {
    if (!args.reconcileRefreshFailure) throw error;
    console.error('Attestation committed but verification cache refresh requires reconciliation:', error);
  }
  return legacyResult;
}

export function validateCampAttestationEvidenceInput(args: {
  mode: 'source' | 'override';
  notes?: string | null;
  sourceRef?: string;
  sourceLocator?: string;
  excerpt?: string;
}): void {
  validateAttestationInputBounds(args);
  if (args.mode === 'override') {
    if (!args.notes?.trim()) throw new AttestationValidationError('An override reason is required.');
    return;
  }
  if (!args.sourceRef?.trim() || !args.excerpt?.trim() || !args.sourceLocator || !parseCharsLocator(args.sourceLocator)) {
    throw new AttestationValidationError('Source attestations require a complete snapshot citation with a chars locator and exact excerpt.');
  }
}

function validateAttestationInputBounds(args: {
  notes?: string | null;
  sourceRef?: string;
  sourceLocator?: string;
  excerpt?: string;
}): void {
  if (args.sourceRef && args.sourceRef.length > MAX_SOURCE_REF_LENGTH) throw new AttestationValidationError('sourceRef is too large.');
  if (args.excerpt && args.excerpt.length > MAX_EXCERPT_LENGTH) throw new AttestationValidationError('excerpt is too large.');
  if (args.notes && args.notes.length > MAX_REASON_LENGTH) throw new AttestationValidationError('Attestation reason is too large.');
  if (args.sourceLocator && args.sourceLocator.length > MAX_LOCATOR_LENGTH) throw new AttestationValidationError('sourceLocator is too large.');
}

export async function addFieldAttestation(opts: {
  entityType: AdminEntityType;
  entityId: string;
  fieldKey: string;
  actor: string;
  mode: 'source' | 'override';
  sourceUrl?: string | null;
  excerpt?: string | null;
  sourceLocator?: string | null;
  notes?: string | null;
  valueSnapshot?: unknown;
}) {
  const pool = getPool();
  validateAttestationInputBounds({
    notes: opts.notes,
    sourceRef: opts.sourceUrl ?? undefined,
    sourceLocator: opts.sourceLocator ?? undefined,
    excerpt: opts.excerpt ?? undefined,
  });
  if (opts.mode === 'override') {
    validateCampAttestationEvidenceInput({ mode: 'override', notes: opts.notes });
  }
  const normalizedNotes = opts.mode === 'override'
    ? `Override attestation: ${opts.notes ?? 'Approved by admin review'}`
    : opts.notes ?? null;
  let sourceCitation: { sourceRef: string; sourceLocator: string; excerpt: string } | undefined;
  if (opts.mode === 'source') {
    const sourceRef = opts.sourceUrl?.trim();
    const excerpt = opts.excerpt?.trim();
    const parsed = sourceRef ? parseSnapshotSourceRef(sourceRef) : undefined;
    if (!sourceRef || !excerpt || !parsed) {
      throw new AttestationValidationError('A valid snapshot sourceRef and excerpt are required for source attestations.');
    }
    const snapshot = await createCampfitSnapshotStore().get(parsed.sourceId, parsed.bodyHash);
    if (!snapshot) throw new AttestationValidationError('The referenced snapshot is unavailable.');
    if (!/^[a-f0-9]{64}$/i.test(parsed.bodyHash) || snapshot.bodyHash !== parsed.bodyHash) {
      throw new AttestationValidationError('The snapshot reference must contain the exact full body hash.');
    }
    if (parsed.url && parsed.url !== snapshot.url) throw new AttestationValidationError('The snapshot URL does not match the stored snapshot.');
    if (parsed.fetchedAt && parsed.fetchedAt !== snapshot.fetchedAt) throw new AttestationValidationError('The snapshot timestamp does not match the stored snapshot.');
    const resolution = resolveReviewExcerpt(excerpt, snapshot.body, opts.sourceLocator);
    if (resolution.state !== 'verified') {
      throw new AttestationValidationError('The excerpt does not resolve uniquely against the referenced snapshot.');
    }
    sourceCitation = { sourceRef: buildSnapshotSourceRef(snapshot), sourceLocator: resolution.locator, excerpt };
  }

  // V8 fix (MEDIUM, review-code.md): the reconciled Claim/Evidence/Event
  // write now runs BEFORE the legacy `FieldAttestation` INSERT, mirroring
  // `/attest/route.ts`'s already-safe ordering. Previously the legacy row
  // committed FIRST and this reconciled write ran after with no try/catch —
  // a failure here (a transient DB error, or a same-subject concurrency
  // conflict) surfaced to the caller as a total failure of an action that
  // had actually already partially succeeded, and a subsequent admin retry
  // would insert a SECOND, duplicate `FieldAttestation` row for the same
  // value (this insert has no idempotency guard). Reordering means: if this
  // call throws, nothing has been durably written yet, so the caller sees an
  // honest total failure and a retry is safe.
  if (!isAllowedAttestationField(opts.entityType, opts.fieldKey)) {
    throw new AttestationValidationError('fieldKey must be a known attestation target.');
  }

  if (opts.entityType === 'CAMP' && VERIFIED_CAMP_CLAIM_SET_FIELDS.includes(opts.fieldKey)) {
    return recordCampAttestationEvidence({
      campId: opts.entityId,
      fields: [opts.fieldKey],
      actor: opts.actor,
      attestedAt: new Date().toISOString(),
      notes: normalizedNotes,
      values: opts.valueSnapshot === undefined ? undefined : { [opts.fieldKey]: opts.valueSnapshot },
      mode: opts.mode,
      sourceRef: sourceCitation?.sourceRef,
      sourceLocator: sourceCitation?.sourceLocator,
      excerpt: sourceCitation?.excerpt,
      reconcileRefreshFailure: true,
      legacyWrite: async (client) => {
        const { rows } = await client.query(
          `INSERT INTO "FieldAttestation"
       ("entityType", "entityId", "fieldKey", "valueSnapshot", excerpt, "sourceUrl", "approvedAt", "approvedBy", "lastRecheckedAt", notes)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now(), $8)
     RETURNING *`,
          [opts.entityType, opts.entityId, opts.fieldKey, opts.valueSnapshot == null ? null : JSON.stringify(opts.valueSnapshot), opts.excerpt ?? null, opts.sourceUrl ?? null, opts.actor, normalizedNotes],
        );
        return rows[0];
      },
    });
  }

  // Non-claim-set fields retain the legacy-only boundary.
  const { rows } = await pool.query(
    `INSERT INTO "FieldAttestation"
       ("entityType", "entityId", "fieldKey", "valueSnapshot", excerpt, "sourceUrl", "approvedAt", "approvedBy", "lastRecheckedAt", notes)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now(), $8)
     RETURNING *`,
    [opts.entityType, opts.entityId, opts.fieldKey, opts.valueSnapshot == null ? null : JSON.stringify(opts.valueSnapshot), opts.excerpt ?? null, opts.sourceUrl ?? null, opts.actor, normalizedNotes],
  );
  return rows[0];
}

export class AttestationValidationError extends Error {
  readonly code = 'invalid_attestation_evidence';
}

const ALLOWED_ATTESTATION_FIELDS: Record<AdminEntityType, readonly string[]> = {
  CAMP: ['name', 'organizationName', 'description', 'websiteUrl', 'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks', 'interestingDetails', 'city', 'state', 'zip', 'neighborhood', 'address', 'lunchIncluded', 'registrationStatus', 'registrationOpenDate', 'registrationCloseDate', 'campTypes', 'categories', 'ageGroups', 'schedules', 'pricing', 'provider'],
  PROVIDER: ['name', 'websiteUrl', 'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks', 'city', 'neighborhood', 'address', 'notes', 'crawlRootUrl', 'people', 'accreditation'],
  PERSON: ['fullName', 'bio', 'contacts'],
};

export function isAllowedAttestationField(entityType: AdminEntityType, fieldKey: string): boolean {
  if (ALLOWED_ATTESTATION_FIELDS[entityType].includes(fieldKey)) return true;
  if (entityType !== 'CAMP') return false;
  const [root, suffix, ...rest] = fieldKey.split(':');
  return rest.length === 0 && Boolean(suffix) && ['ageGroups', 'schedules', 'pricing'].includes(root);
}

export async function ensurePerson(opts: {
  fullName: string;
  contactMethods?: Array<{ type: string; value: string; label?: string | null }>;
}) {
  const pool = getPool();
  const base = slugify(opts.fullName);
  let slug = base;
  let attempt = 2;
  while (true) {
    const existing = await pool.query(`SELECT id FROM "Person" WHERE slug = $1`, [slug]);
    if (existing.rows.length === 0) break;
    slug = `${base}-${attempt++}`;
  }
  const { rows } = await pool.query(
    `INSERT INTO "Person" ("fullName", slug)
     VALUES ($1, $2)
     RETURNING *`,
    [opts.fullName, slug],
  );
  const person = rows[0];
  for (const method of opts.contactMethods ?? []) {
    await pool.query(
      `INSERT INTO "PersonContactMethod" ("personId", type, value, label)
       VALUES ($1, $2, $3, $4)`,
      [person.id, method.type, method.value, method.label ?? null],
    );
  }
  return person;
}

export async function linkPersonToEntity(opts: {
  entityType: 'CAMP' | 'PROVIDER';
  entityId: string;
  personId: string;
  actor: string;
  title?: string | null;
  roleType?: string | null;
  notes?: string | null;
  sourceUrl?: string | null;
  excerpt?: string | null;
}) {
  const pool = getPool();
  const table = opts.entityType === 'CAMP' ? 'CampPersonRole' : 'ProviderPersonRole';
  const foreignKey = opts.entityType === 'CAMP' ? 'campId' : 'providerId';
  const { rows } = await pool.query(
    `INSERT INTO "${table}" ("${foreignKey}", "personId", title, "roleType", notes, "sourceUrl", excerpt, "approvedAt", "approvedBy")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
     RETURNING *`,
    [opts.entityId, opts.personId, opts.title ?? null, opts.roleType ?? 'CONTACT', opts.notes ?? null, opts.sourceUrl ?? null, opts.excerpt ?? null, opts.actor],
  );
  return rows[0];
}

export async function addCampAccreditation(opts: {
  campId: string;
  bodyName: string;
  actor: string;
  status?: string | null;
  scope?: string | null;
  sourceUrl?: string | null;
  excerpt?: string | null;
  notes?: string | null;
}) {
  const pool = getPool();
  const slug = slugify(opts.bodyName);
  const bodyResult = await pool.query(
    `INSERT INTO "AccreditationBody" (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug)
     DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [opts.bodyName, slug],
  );
  const body = bodyResult.rows[0];
  const { rows } = await pool.query(
    `INSERT INTO "CampAccreditation"
       ("campId", "bodyId", status, scope, "sourceUrl", excerpt, "approvedAt", "approvedBy", "lastVerifiedAt", notes)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now(), $8)
     RETURNING *`,
    [opts.campId, body.id, opts.status ?? 'ACTIVE', opts.scope ?? null, opts.sourceUrl ?? null, opts.excerpt ?? null, opts.actor, opts.notes ?? null],
  );
  return { body, accreditation: rows[0] };
}

export async function createCampProposal(opts: {
  campId: string;
  sourceUrl: string;
  proposedChanges: Record<string, unknown>;
  actor: string;
  reviewerNotes?: string | null;
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "CampChangeProposal"
       ("campId", "crawlRunId", "sourceUrl", "rawExtraction", "proposedChanges", "overallConfidence", "extractionModel", "reviewerNotes")
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      opts.campId,
      opts.sourceUrl,
      JSON.stringify({ source: 'admin-assistant', actor: opts.actor }),
      JSON.stringify(opts.proposedChanges),
      0.75,
      'admin-assistant',
      opts.reviewerNotes ?? null,
    ],
  );
  return rows[0];
}

export async function createProviderProposal(opts: {
  providerId: string;
  sourceUrl: string;
  proposedChanges: Record<string, unknown>;
  actor: string;
  reviewerNotes?: string | null;
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "ProviderChangeProposal"
       ("providerId", "sourceUrl", "proposedChanges", "overallConfidence", "reviewerNotes")
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      opts.providerId,
      opts.sourceUrl,
      JSON.stringify(opts.proposedChanges),
      0.75,
      opts.reviewerNotes ?? null,
    ],
  );
  return rows[0];
}

export async function logAiAction(opts: {
  capability: AiCapability;
  action: string;
  entityType?: AdminEntityType | null;
  entityId?: string | null;
  requestedBy: string;
  requiresConfirmation: boolean;
  input?: unknown;
  status?: AiActionStatus;
  output?: unknown;
  error?: string | null;
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "AiActionLog"
       (capability, action, "entityType", "entityId", status, "requestedBy", "requiresConfirmation", input, output, error, "completedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $5 IN ('COMPLETED', 'FAILED', 'REJECTED') THEN now() ELSE NULL END)
     RETURNING *`,
    [
      opts.capability,
      opts.action,
      opts.entityType ?? null,
      opts.entityId ?? null,
      opts.status ?? 'REQUESTED',
      opts.requestedBy,
      opts.requiresConfirmation,
      opts.input == null ? null : JSON.stringify(opts.input),
      opts.output == null ? null : JSON.stringify(opts.output),
      opts.error ?? null,
    ],
  );
  return rows[0];
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'item';
}
