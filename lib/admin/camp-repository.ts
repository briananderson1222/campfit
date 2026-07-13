/**
 * lib/admin/camp-repository.ts — admin camp-create repository (campfit#90
 * Wave 2 Task B / R3 / AC3). Mirrors `provider-repository.ts`'s
 * `createProvider`/`makeUniqueSlug` shape. Raw `pg` via `getPool()` only —
 * no ORM. Schema source of truth is the SQL in `prisma/migrations/`, run
 * through node-pg-migrate (see `scripts/test-db-reset.ts`'s header comment).
 */
import { getPool } from '@/lib/db';
import type { Camp, CampType, CampCategory, CampAgeGroup, CampSchedule, CampPricing } from '@/lib/types';
import { isValidHttpUrl } from './onboarding-validation';
import { writeChangeLogs } from './changelog-repository';
import { RepositoryConnectionError } from './repository-errors';

function db() {
  return getPool();
}

export async function updateCampAttestationAuditTrail(
  campId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db().query(
    `UPDATE "Camp"
     SET "fieldSources" = COALESCE("fieldSources", '{}') || $1::jsonb,
         "lastVerifiedAt" = now()
     WHERE id = $2`,
    [JSON.stringify(patch), campId],
  );
}

const ADMIN_CAMP_EDITABLE_FIELDS = new Set([
  'name', 'organizationName', 'providerId', 'websiteUrl', 'description', 'notes', 'interestingDetails',
  'campType', 'category', 'campTypes', 'categories', 'registrationStatus', 'registrationOpenDate',
  'lunchIncluded', 'city', 'neighborhood', 'address', 'state', 'zip',
  'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
]);

export async function updateAdminCampFields(
  campId: string,
  updates: Array<[string, unknown]>,
): Promise<Record<string, unknown> | null> {
  for (const [field] of updates) {
    if (!ADMIN_CAMP_EDITABLE_FIELDS.has(field)) throw new Error(`Invalid editable camp field: ${field}`);
  }
  const { rows } = await db().query<Record<string, unknown>>(`SELECT * FROM "Camp" WHERE id = $1`, [campId]);
  const current = rows[0];
  if (!current) return null;
  const setClauses = updates.map(([field], index) => `"${field}" = $${index + 2}`).join(', ');
  await db().query(`UPDATE "Camp" SET ${setClauses}, "updatedAt" = NOW() WHERE id = $1`, [
    campId,
    ...updates.map(([, value]) => value ?? null),
  ]);
  return current;
}

export interface AgeGroupInput {
  label: string;
  minAge: number | null;
  maxAge: number | null;
  minGrade: number | null;
  maxGrade: number | null;
}

export async function replaceAdminCampAgeGroups(campId: string, ageGroups: AgeGroupInput[], changedBy: string) {
  const client = await db().connect().catch((error) => {
    throw new RepositoryConnectionError(error);
  });
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT label, "minAge", "maxAge", "minGrade", "maxGrade"
       FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge" ASC NULLS LAST`, [campId]);
    await client.query(`DELETE FROM "CampAgeGroup" WHERE "campId" = $1`, [campId]);
    for (const ag of ageGroups) {
      if (!ag.label?.trim()) continue;
      await client.query(
        `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
        [campId, ag.label.trim(), ag.minAge ?? null, ag.maxAge ?? null, ag.minGrade ?? null, ag.maxGrade ?? null]);
    }
    await client.query(`UPDATE "Camp" SET "updatedAt" = now() WHERE id = $1`, [campId]);
    await client.query('COMMIT');
    await writeChangeLogs([{
      campId, proposalId: null, changedBy, fieldName: 'ageGroups', oldValue: previous.rows,
      newValue: ageGroups.filter((row) => row.label?.trim()),
      changeType: previous.rows.length === 0 ? 'FIELD_POPULATED' : 'UPDATE',
    }]).catch((error) => console.error('[age-groups PUT] writeChangeLogs failed:', error));
    const { rows } = await client.query(
      `SELECT * FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge" ASC NULLS LAST`, [campId]);
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type AdminCampDetail = Omit<Camp, 'organizationName' | 'providerId' | 'fieldSources' | 'registrationCloseDate'> & {
  organizationName: string | null;
  providerId: string | null;
  fieldSources: Exclude<Camp['fieldSources'], undefined>;
  registrationCloseDate: string | null;
  createdAt: string;
  updatedAt: string;
  ageGroups: CampAgeGroup[];
  schedules: CampSchedule[];
  pricing: CampPricing[];
};

export type AdminCampPendingProposal = {
  id: string;
  createdAt: string;
  overallConfidence: number;
  appliedFields: string[];
  fieldCount: number | null;
};

export interface AdminCampRow {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  dataConfidence: string;
  lastVerifiedAt: string | null;
  communitySlug: string;
  registrationStatus: string;
  scheduleCount: number;
  missingFieldCount: number;
  pendingProposals: number;
}

export async function getAdminCampDetail(campId: string): Promise<AdminCampDetail | null> {
  type CampDatabaseRow = Omit<AdminCampDetail, 'ageGroups' | 'schedules' | 'pricing' | 'registrationOpenDate' | 'registrationCloseDate'> & {
    registrationOpenDate: string | Date | null;
    registrationCloseDate: string | Date | null;
  };
  const [campRes, ageRes, schedRes, priceRes] = await Promise.all([
    db().query<CampDatabaseRow>(`SELECT * FROM "Camp" WHERE id = $1`, [campId]),
    db().query<CampAgeGroup>(`SELECT * FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge" ASC NULLS LAST`, [campId]),
    db().query<CampSchedule>(`SELECT * FROM "CampSchedule" WHERE "campId" = $1 ORDER BY "startDate" ASC`, [campId]),
    db().query<CampPricing>(`SELECT * FROM "CampPricing" WHERE "campId" = $1 ORDER BY amount ASC`, [campId]),
  ]);
  if (!campRes.rows[0]) return null;
  const camp = campRes.rows[0];
  if (camp.registrationOpenDate instanceof Date) {
    camp.registrationOpenDate = camp.registrationOpenDate.toISOString().split('T')[0];
  }
  if (camp.registrationCloseDate instanceof Date) {
    camp.registrationCloseDate = camp.registrationCloseDate.toISOString().split('T')[0];
  }
  if (!Array.isArray(camp.campTypes)) camp.campTypes = camp.campType ? [camp.campType] : [];
  if (!Array.isArray(camp.categories)) camp.categories = camp.category ? [camp.category] : [];
  return { ...camp, ageGroups: ageRes.rows, schedules: schedRes.rows, pricing: priceRes.rows } as AdminCampDetail;
}

export async function getAdminCampPendingProposals(campId: string): Promise<AdminCampPendingProposal[]> {
  const { rows } = await db().query<AdminCampPendingProposal>(
    `SELECT id, "createdAt", "overallConfidence", "appliedFields",
            (SELECT count(*)::int FROM jsonb_object_keys("proposedChanges")) AS "fieldCount"
     FROM "CampChangeProposal"
     WHERE "campId" = $1 AND status = 'PENDING'
     ORDER BY priority DESC, "createdAt" DESC`,
    [campId],
  );
  return rows;
}

export async function getAdminCampsWithQuality(
  archived: 'active' | 'archived' = 'active',
  communitySlugs?: string[],
): Promise<AdminCampRow[]> {
  const values: unknown[] = [];
  const communityClause = communitySlugs && communitySlugs.length > 0
    ? `AND c."communitySlug" = ANY($1::text[])`
    : '';
  if (communityClause) values.push(communitySlugs);
  const { rows } = await db().query<AdminCampRow>(`
    SELECT c.id, c.name, c.slug, c."websiteUrl", c."dataConfidence", c."lastVerifiedAt",
      c."communitySlug", c."registrationStatus",
      (SELECT COUNT(*)::int FROM "CampSchedule" s WHERE s."campId" = c.id) AS "scheduleCount",
      (CASE WHEN c.description = '' OR c.description IS NULL THEN 1 ELSE 0 END +
       CASE WHEN c."websiteUrl" = '' OR c."websiteUrl" IS NULL THEN 1 ELSE 0 END +
       CASE WHEN c.neighborhood = '' OR c.neighborhood IS NULL THEN 1 ELSE 0 END +
       CASE WHEN c."registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
      (SELECT COUNT(*)::int FROM "CampChangeProposal"
       WHERE "campId" = c.id AND status = 'PENDING') AS "pendingProposals"
    FROM "Camp" c
    WHERE c."archivedAt" IS ${archived === 'archived' ? 'NOT NULL' : 'NULL'}
      ${communityClause}
    ORDER BY "missingFieldCount" DESC, "lastVerifiedAt" ASC NULLS FIRST
  `, values);
  return rows;
}

/**
 * Thrown for any camp-create input problem the route should surface as a
 * 400: missing/blank `providerId`, a `providerId` that doesn't resolve to an
 * existing non-archived `Provider` (camp create must never orphan a camp —
 * see the plan's "Camp-create bypassing provider linkage" stop-short risk),
 * or an invalid `websiteUrl`.
 */
export class CampCreateValidationError extends Error {}

type CreateCampInput = {
  name: string;
  providerId: string;
  campType: CampType;
  category: CampCategory;
  websiteUrl?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  address?: string | null;
};

/**
 * Inserts a new `Camp` linked to an existing, non-archived `Provider`.
 * `campTypes`/`categories` are set to the single selected value
 * (`[campType]`/`[category]`), matching `onboard-url/route.ts`'s existing
 * single-value convention. New camps are unverified until crawled
 * (`dataConfidence: 'PLACEHOLDER'`), matching onboard-url's convention.
 */
export async function createCamp(input: CreateCampInput): Promise<Camp> {
  const providerId = input.providerId?.trim();
  if (!providerId) {
    throw new CampCreateValidationError('providerId is required');
  }
  if (!input.name?.trim()) {
    throw new CampCreateValidationError('name is required');
  }
  if (input.websiteUrl && !isValidHttpUrl(input.websiteUrl)) {
    throw new CampCreateValidationError('Website URL must be a valid http(s) URL');
  }

  const { rows: providerRows } = await db().query<{ id: string; communitySlug: string }>(
    `SELECT id, "communitySlug" FROM "Provider" WHERE id = $1 AND "archivedAt" IS NULL`,
    [providerId],
  );
  const provider = providerRows[0];
  if (!provider) {
    throw new CampCreateValidationError('providerId must reference an existing, non-archived provider');
  }

  const camp = await insertCampWithUniqueSlug(input, provider);
  return camp;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Inserts the Camp row, retrying with a suffixed slug candidate on a unique-
 * slug conflict. A check-then-insert (`SELECT ... WHERE slug = $1` followed
 * by a plain `INSERT`) has a TOCTOU race: two concurrent creates for the
 * same name could both pass the `SELECT` for the same candidate before
 * either inserts, and the losing `INSERT` would then throw a raw Postgres
 * unique-violation instead of a clean result. Using `INSERT ... ON CONFLICT
 * (slug) DO NOTHING RETURNING *` and retrying with the next candidate on a
 * miss closes that window — mirroring the same pattern `onboard-url/route.ts`
 * already uses for its own Provider/Camp inserts.
 */
async function insertCampWithUniqueSlug(
  input: CreateCampInput,
  provider: { id: string; communitySlug: string },
): Promise<Camp> {
  const base = slugify(input.name);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await db().query<Camp>(`
      INSERT INTO "Camp"
        (name, slug, "websiteUrl", "communitySlug", "providerId",
         "campType", category, "campTypes", "categories",
         city, neighborhood, address, "dataConfidence")
      VALUES ($1,$2,$3,$4,$5,$6,$7,ARRAY[$6]::"CampType"[],ARRAY[$7]::"CampCategory"[],$8,$9,$10,'PLACEHOLDER')
      ON CONFLICT (slug) DO NOTHING
      RETURNING *
    `, [
      input.name.trim(), slug, input.websiteUrl ?? '', provider.communitySlug, provider.id,
      input.campType, input.category,
      input.city ?? 'Denver', input.neighborhood ?? '', input.address ?? '',
    ]);
    if (rows[0]) return rows[0];
    slug = `${base}-${attempt++}`;
  }
}
