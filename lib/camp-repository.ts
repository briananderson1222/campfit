/**
 * lib/camp-repository.ts — typed queries for the Camp domain
 *
 * All functions use raw pg to avoid Prisma binary requirements on
 * non-x64 platforms. Returns fully typed Camp objects (lib/types.ts).
 */

import { getPool } from "@/lib/db";
import { Camp, CampCategory, CampType } from "@/lib/types";

// ─── SQL ──────────────────────────────────────────────────────────────────

const CAMPS_WITH_RELATIONS_SQL = `
  SELECT
    c.*,
    c."registrationOpenDate"::text AS "registrationOpenDate",
    COALESCE(
      json_agg(DISTINCT jsonb_build_object(
        'id', ag."id",
        'label', ag."label",
        'minAge', ag."minAge",
        'maxAge', ag."maxAge",
        'minGrade', ag."minGrade",
        'maxGrade', ag."maxGrade"
      )) FILTER (WHERE ag."id" IS NOT NULL),
      '[]'
    ) AS "ageGroups",
    COALESCE(
      json_agg(jsonb_build_object(
        'id', s."id",
        'label', s."label",
        'startDate', s."startDate"::text,
        'endDate', s."endDate"::text,
        'startTime', s."startTime",
        'endTime', s."endTime",
        'earlyDropOff', s."earlyDropOff",
        'latePickup', s."latePickup"
      ) ORDER BY s."startDate" ASC, s."label" ASC) FILTER (WHERE s."id" IS NOT NULL),
      '[]'
    ) AS "schedules",
    COALESCE(
      json_agg(DISTINCT jsonb_build_object(
        'id', p."id",
        'label', p."label",
        'amount', p."amount"::float,
        'unit', p."unit",
        'durationWeeks', p."durationWeeks",
        'ageQualifier', p."ageQualifier",
        'discountNotes', p."discountNotes"
      )) FILTER (WHERE p."id" IS NOT NULL),
      '[]'
    ) AS "pricing"
  FROM "Camp" c
  LEFT JOIN "CampAgeGroup" ag ON ag."campId" = c."id"
  LEFT JOIN "CampSchedule" s ON s."campId" = c."id"
  LEFT JOIN "CampPricing" p ON p."campId" = c."id"
`;

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch all camps with their related age groups, schedules, and pricing.
 */
export async function getAllCamps(): Promise<Camp[]> {
  const pool = getPool();
  const result = await pool.query<Camp>(
    `${CAMPS_WITH_RELATIONS_SQL} GROUP BY c."id" ORDER BY c."name"`
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
 * Fetch camps filtered by category and/or camp type.
 * Full-text and age filtering is done client-side after fetching.
 */
export async function getCampsByType(
  campType?: CampType,
  category?: CampCategory
): Promise<Camp[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: (string | undefined)[] = [];

  if (campType) {
    params.push(campType);
    conditions.push(`c."campType" = $${params.length}::"CampType"`);
  }
  if (category) {
    params.push(category);
    conditions.push(`c."category" = $${params.length}::"CampCategory"`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await pool.query<Camp>(
    `${CAMPS_WITH_RELATIONS_SQL} ${where} GROUP BY c."id" ORDER BY c."name"`,
    params
  );
  return result.rows;
}

/**
 * Lightweight camp list (no relations) for building metadata or sitemaps.
 */
export async function getCampSlugs(): Promise<{ slug: string; name: string }[]> {
  const pool = getPool();
  const result = await pool.query<{ slug: string; name: string }>(
    `SELECT "slug", "name" FROM "Camp" ORDER BY "name"`
  );
  return result.rows;
}
