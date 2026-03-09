/**
 * lib/camp-repository.ts — typed queries for the Camp domain
 *
 * All functions use raw pg to avoid Prisma binary requirements on
 * non-x64 platforms. Returns fully typed Camp objects (lib/types.ts).
 */

import { getPool } from "@/lib/db";
import { Camp, CampCategory, CampType, Community } from "@/lib/types";

// ─── SQL ──────────────────────────────────────────────────────────────────

const CAMPS_WITH_RELATIONS_SQL = `
  SELECT
    c.*,
    c."communitySlug", c."displayName",
    c."registrationOpenDate"::text AS "registrationOpenDate",
    COALESCE((
      SELECT json_agg(jsonb_build_object(
        'id', ag."id", 'label', ag."label",
        'minAge', ag."minAge", 'maxAge', ag."maxAge",
        'minGrade', ag."minGrade", 'maxGrade', ag."maxGrade"
      ) ORDER BY ag."minAge" ASC NULLS LAST, ag."label" ASC)
      FROM "CampAgeGroup" ag WHERE ag."campId" = c."id"
    ), '[]') AS "ageGroups",
    COALESCE((
      SELECT json_agg(jsonb_build_object(
        'id', s."id", 'label', s."label",
        'startDate', s."startDate"::text, 'endDate', s."endDate"::text,
        'startTime', s."startTime", 'endTime', s."endTime",
        'earlyDropOff', s."earlyDropOff", 'latePickup', s."latePickup"
      ) ORDER BY s."startDate" ASC NULLS LAST, s."label" ASC)
      FROM "CampSchedule" s WHERE s."campId" = c."id"
    ), '[]') AS "schedules",
    COALESCE((
      SELECT json_agg(jsonb_build_object(
        'id', p."id", 'label', p."label",
        'amount', p."amount"::float, 'unit', p."unit",
        'durationWeeks', p."durationWeeks",
        'ageQualifier', p."ageQualifier", 'discountNotes', p."discountNotes"
      ) ORDER BY p."amount" ASC NULLS LAST)
      FROM "CampPricing" p WHERE p."campId" = c."id"
    ), '[]') AS "pricing"
  FROM "Camp" c
`;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch all camps for a community with their related age groups, schedules, and pricing.
 */
export async function getAllCamps(communitySlug: string): Promise<Camp[]> {
  const pool = getPool();
  const result = await pool.query<Camp>(
    `${CAMPS_WITH_RELATIONS_SQL} WHERE c."communitySlug" = $1 GROUP BY c."id" ORDER BY c."name"`,
    [communitySlug]
  );
  return result.rows;
}

/**
 * Fetch a single camp by slug, with all related data.
 */
export async function getCampBySlug(slug: string): Promise<Camp | null> {
  const pool = getPool();
  const result = await pool.query<Camp>(
    `${CAMPS_WITH_RELATIONS_SQL} WHERE c."slug" = $1 GROUP BY c."id"`,
    [slug]
  );
  return result.rows[0] ?? null;
}

/**
 * Fetch camps filtered by community, category and/or camp type.
 * Full-text and age filtering is done client-side after fetching.
 */
export async function getCampsByType(
  communitySlug: string,
  campType?: CampType,
  category?: CampCategory
): Promise<Camp[]> {
  const pool = getPool();
  const conditions: string[] = [`c."communitySlug" = $1`];
  const params: (string | undefined)[] = [communitySlug];

  if (campType) {
    params.push(campType);
    conditions.push(`c."campType" = $${params.length}::"CampType"`);
  }
  if (category) {
    params.push(category);
    conditions.push(`c."category" = $${params.length}::"CampCategory"`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const result = await pool.query<Camp>(
    `${CAMPS_WITH_RELATIONS_SQL} ${where} GROUP BY c."id" ORDER BY c."name"`,
    params
  );
  return result.rows;
}

/**
 * Lightweight camp list (no relations) for building metadata or sitemaps.
 */
export async function getCampSlugs(): Promise<{ slug: string; name: string; communitySlug: string }[]> {
  const pool = getPool();
  const result = await pool.query<{ slug: string; name: string; communitySlug: string }>(
    `SELECT "slug", "name", "communitySlug" FROM "Camp" ORDER BY "name"`
  );
  return result.rows;
}

/**
 * Returns distinct communities with camp counts, ordered by count descending.
 */
export async function getDistinctCommunities(): Promise<Community[]> {
  const pool = getPool();
  const result = await pool.query<Community>(
    `SELECT "communitySlug", "displayName", COUNT(*)::int AS count
     FROM "Camp"
     GROUP BY "communitySlug", "displayName"
     ORDER BY count DESC`
  );
  return result.rows;
}
