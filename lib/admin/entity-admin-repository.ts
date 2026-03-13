import { getPool } from '@/lib/db';

export type AdminEntityType = 'CAMP' | 'PROVIDER' | 'PERSON';
export type AiCapability = 'READ' | 'PROPOSE' | 'WRITE';
export type AiActionStatus = 'REQUESTED' | 'CONFIRMED' | 'REJECTED' | 'COMPLETED' | 'FAILED';

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

export async function addFieldAttestation(opts: {
  entityType: AdminEntityType;
  entityId: string;
  fieldKey: string;
  actor: string;
  sourceUrl?: string | null;
  excerpt?: string | null;
  notes?: string | null;
  valueSnapshot?: unknown;
}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO "FieldAttestation"
       ("entityType", "entityId", "fieldKey", "valueSnapshot", excerpt, "sourceUrl", "approvedAt", "approvedBy", "lastRecheckedAt", notes)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now(), $8)
     RETURNING *`,
    [
      opts.entityType,
      opts.entityId,
      opts.fieldKey,
      opts.valueSnapshot == null ? null : JSON.stringify(opts.valueSnapshot),
      opts.excerpt ?? null,
      opts.sourceUrl ?? null,
      opts.actor,
      opts.notes ?? null,
    ],
  );
  return rows[0];
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
