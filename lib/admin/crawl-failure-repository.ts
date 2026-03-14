import { getPool } from '@/lib/db';
import { communityScopeSql } from './community-access';

export interface UncrawlableCampRow {
  campId: string;
  campName: string;
  campSlug: string;
  communitySlug: string;
  websiteUrl: string | null;
  latestError: string;
  latestUrl: string | null;
  latestRunId: string;
  latestStartedAt: string;
  failureCount: number;
}

export async function getUncrawlableCamps(opts?: {
  communitySlugs?: string[];
  limit?: number;
}) {
  const pool = getPool();
  const limit = opts?.limit ?? 200;
  const values: unknown[] = [];
  const communityScope = communityScopeSql(opts?.communitySlugs, `c."communitySlug"`, values.length + 1);
  if (communityScope.values.length > 0) values.push(...communityScope.values);

  const result = await pool.query<UncrawlableCampRow>(
    `
      WITH recent_errors AS (
        SELECT
          cr.id AS run_id,
          cr."startedAt",
          entry->>'campId' AS camp_id,
          entry->>'error' AS error,
          entry->>'url' AS url
        FROM "CrawlRun" cr
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cr."errorLog", '[]'::jsonb)) entry
        WHERE cr."startedAt" >= now() - interval '45 days'
      ),
      ranked AS (
        SELECT
          recent_errors.*,
          row_number() OVER (PARTITION BY camp_id ORDER BY "startedAt" DESC) AS rn,
          count(*) OVER (PARTITION BY camp_id) AS failure_count
        FROM recent_errors
      )
      SELECT
        c.id AS "campId",
        c.name AS "campName",
        c.slug AS "campSlug",
        c."communitySlug",
        c."websiteUrl",
        ranked.error AS "latestError",
        ranked.url AS "latestUrl",
        ranked.run_id AS "latestRunId",
        ranked."startedAt" AS "latestStartedAt",
        ranked.failure_count::int AS "failureCount"
      FROM ranked
      JOIN "Camp" c ON c.id = ranked.camp_id
      WHERE ranked.rn = 1
        AND c."archivedAt" IS NULL
        ${communityScope.clause}
      ORDER BY ranked.failure_count DESC, ranked."startedAt" DESC
      LIMIT $${values.length + 1}
    `,
    [...values, limit],
  );

  return result.rows;
}

export async function getUncrawlableCampCount(communitySlugs?: string[]) {
  const rows = await getUncrawlableCamps({ communitySlugs, limit: 500 });
  return rows.length;
}
