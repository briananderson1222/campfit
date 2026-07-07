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

/**
 * `errorLog.campId` values fall into two disjoint families (campfit#85 Wave
 * 5 decision — see this file's other doc comments and
 * `lib/ingestion/crawl-pipeline.ts`'s `sourceFailureCampId`):
 *
 *  - a real `Camp.id` (camp-path failures, and sources-strategy failures
 *    for an item that WAS successfully routed/anchored) — these are what
 *    `getUncrawlableCamps` below surfaces.
 *  - `source:<sourceKey>` (sources-strategy failures recorded BEFORE any
 *    item/campId could be resolved — a whole-source fetch/extraction
 *    failure, a provider-init failure, or a zero-item page) — these
 *    deliberately do NOT get a placeholder `Camp` row created for them
 *    (mirrors `scripts/scrape.ts`'s pre-existing "don't create camps you're
 *    not going to route items to" discipline), so they can never satisfy
 *    `getUncrawlableCamps`'s `JOIN "Camp"` — by design, not by accident.
 *    `getUnassignedSourceFailures` below is the intentional, explicit,
 *    non-blank, non-silent surface for exactly this family, so a
 *    source-sweep failure is never simply invisible the way the
 *    pre-convergence `campId: ""` placeholder made it.
 */
const SOURCE_FAILURE_CAMP_ID_PREFIX = 'source:';

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

export interface UnassignedSourceFailureRow {
  /** the `IngestionSourceConfig.key` this failure belongs to (never a Camp — see the file doc above). */
  sourceKey: string;
  latestError: string;
  latestUrl: string | null;
  latestRunId: string;
  latestStartedAt: string;
  failureCount: number;
}

/**
 * The explicit, labeled surface for sources-strategy `errorLog` entries that
 * were recorded before any `Camp` row existed to anchor them to
 * (`source:<sourceKey>` — see `SOURCE_FAILURE_CAMP_ID_PREFIX`'s doc above and
 * `lib/ingestion/crawl-pipeline.ts`'s `sourceFailureCampId`). This is
 * campfit#85 Wave 5's chosen convention (option (b) from the plan: keep
 * these entries non-joinable to `Camp` on purpose, rather than manufacturing
 * a placeholder `Camp` row per failed source, but make that choice visible
 * via a dedicated query instead of silently excluding them from
 * `getUncrawlableCamps`'s Camp-joined table) — an "unassigned source
 * failures" bucket, distinct from the per-camp failures table.
 */
export async function getUnassignedSourceFailures(opts?: {
  limit?: number;
}): Promise<UnassignedSourceFailureRow[]> {
  const pool = getPool();
  const limit = opts?.limit ?? 200;

  const result = await pool.query<UnassignedSourceFailureRow>(
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
          AND entry->>'campId' LIKE $1
      ),
      ranked AS (
        SELECT
          recent_errors.*,
          row_number() OVER (PARTITION BY camp_id ORDER BY "startedAt" DESC) AS rn,
          count(*) OVER (PARTITION BY camp_id) AS failure_count
        FROM recent_errors
      )
      SELECT
        substring(camp_id from ${SOURCE_FAILURE_CAMP_ID_PREFIX.length + 1}) AS "sourceKey",
        error AS "latestError",
        url AS "latestUrl",
        run_id AS "latestRunId",
        "startedAt" AS "latestStartedAt",
        failure_count::int AS "failureCount"
      FROM ranked
      WHERE rn = 1
      ORDER BY failure_count DESC, "startedAt" DESC
      LIMIT $2
    `,
    [`${SOURCE_FAILURE_CAMP_ID_PREFIX}%`, limit],
  );

  return result.rows;
}
