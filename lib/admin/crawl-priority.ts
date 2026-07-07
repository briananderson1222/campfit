/**
 * lib/admin/crawl-priority.ts — the priority→campIds resolver (campfit#92,
 * Wave 1).
 *
 * Extracted verbatim (same WHERE/ORDER BY/scoring SQL, same parameter
 * binding) from `app/api/admin/crawl/preview/route.ts`'s base-priority
 * branch (the `never_crawled`/`coming_soon`/`missing`/staleness-score
 * branch — NOT the `ids`/`campId`/`specific`-search branches, which stay
 * route-local since the cron path never needs them and this module must not
 * grow scope beyond what both callers actually share).
 *
 * Two callers, one implementation (consume-never-fork):
 *  - `app/api/admin/crawl/preview/route.ts`'s base-priority branch — calls
 *    this for its existing response, unchanged shape/ordering/behavior.
 *  - `app/api/cron/crawl/route.ts` (Wave 2) — calls this directly with
 *    `priority` restricted to `'stale'|'never_crawled'` only (the schedule's
 *    own vocabulary; see `lib/admin/schedule-repository.ts`'s
 *    `CrawlSchedulePriority`) and `limit` = the schedule's `batchSize`, then
 *    maps the result to `campIds` for `runCrawlPipeline`.
 *
 * Return shape is intentionally the FULL row shape the preview route's
 * response already exposes (id/name/communitySlug/websiteUrl/dataConfidence/
 * registrationStatus/lastVerifiedAt/missingFieldCount/priorityScore) — a
 * superset of the `{ id, websiteUrl }` the cron caller actually reads off of
 * it — rather than a narrower `{ id, websiteUrl }[]`, so the preview route's
 * JSON response contract stays byte-for-byte unchanged after this refactor
 * (one shared query, not a second one re-fetched for display fields).
 */
import { getPool } from '@/lib/db';

/** Base-priority vocabulary this resolver's SQL branches on. Does NOT
 * include `'specific'`/`'ids'`/`'campId'`-style lookups — those stay
 * route-local in `preview/route.ts` since they need free-text/explicit-id
 * input the cron path never has. */
export type CrawlCandidatePriority = 'stale' | 'missing' | 'coming_soon' | 'never_crawled' | 'all';

export interface CrawlCandidate {
  id: string;
  name: string;
  communitySlug: string;
  websiteUrl: string;
  dataConfidence: string;
  registrationStatus: string;
  lastVerifiedAt: string | null;
  missingFieldCount: number;
  priorityScore: number;
}

export interface ResolveCrawlCandidatesOptions {
  priority: CrawlCandidatePriority;
  limit: number;
  /**
   * `string` — a single explicit community filter (the route's `community`
   * query param). `string[]` — a moderator's scoped-communities restriction
   * (`auth.access.communities`); an empty array preserves the pre-refactor
   * behavior of `= ANY(ARRAY[]::text[])` matching zero rows, not "no
   * filter". `null`/`undefined` — no community filter (admin, unscoped).
   */
  communitySlug?: string | string[] | null;
}

/**
 * Resolves the base-priority branch's candidate camps: only camps with a
 * crawlable URL, filtered/scored per `priority`, ordered by `priorityScore`
 * DESC then `lastVerifiedAt` ASC NULLS FIRST (never-crawled camps first
 * among equally-scored rows), limited to `limit`.
 */
export async function resolveCrawlCandidates(
  opts: ResolveCrawlCandidatesOptions
): Promise<CrawlCandidate[]> {
  const pool = getPool();

  let whereClause = `"websiteUrl" IS NOT NULL AND "websiteUrl" != ''`;
  const params: unknown[] = [];

  if (typeof opts.communitySlug === 'string') {
    params.push(opts.communitySlug);
    whereClause += ` AND "communitySlug" = $${params.length}`;
  } else if (Array.isArray(opts.communitySlug)) {
    params.push(opts.communitySlug);
    whereClause += ` AND "communitySlug" = ANY($${params.length}::text[])`;
  }

  // Priority-specific filters (same three branches as the pre-extraction
  // route; 'stale' and 'all' both fall through with no extra WHERE clause,
  // differing only via priorityScore ordering — same as before extraction).
  if (opts.priority === 'never_crawled') {
    whereClause += ` AND "lastVerifiedAt" IS NULL`;
  } else if (opts.priority === 'coming_soon') {
    whereClause += ` AND "registrationStatus" = 'COMING_SOON'`;
  } else if (opts.priority === 'missing') {
    whereClause += ` AND (description = '' OR description IS NULL OR neighborhood = '' OR neighborhood IS NULL OR "registrationStatus" = 'UNKNOWN')`;
  }

  const result = await pool.query<CrawlCandidate>(
    `
    SELECT
      id, name, "communitySlug", "websiteUrl", "dataConfidence", "registrationStatus",
      "lastVerifiedAt",
      (CASE WHEN description = '' OR description IS NULL THEN 1 ELSE 0 END +
       CASE WHEN neighborhood = '' OR neighborhood IS NULL THEN 1 ELSE 0 END +
       CASE WHEN "registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
      (
        -- Staleness score: days since last verified (max 180 pts)
        LEAST(180, COALESCE(
          EXTRACT(DAY FROM (NOW() - "lastVerifiedAt"))::int,
          180
        )) +
        -- Missing fields (30 pts each, max 90)
        (CASE WHEN description = '' OR description IS NULL THEN 1 ELSE 0 END +
         CASE WHEN neighborhood = '' OR neighborhood IS NULL THEN 1 ELSE 0 END +
         CASE WHEN "registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) * 30 +
        -- Confidence bonus
        CASE "dataConfidence"
          WHEN 'PLACEHOLDER' THEN 50
          WHEN 'STALE' THEN 25
          ELSE 0
        END +
        -- Coming soon bonus (time-sensitive)
        CASE WHEN "registrationStatus" = 'COMING_SOON' THEN 40 ELSE 0 END
      ) AS "priorityScore"
    FROM "Camp"
    WHERE ${whereClause}
    ORDER BY "priorityScore" DESC, "lastVerifiedAt" ASC NULLS FIRST
    LIMIT $${params.length + 1}
  `,
    [...params, opts.limit]
  );

  return result.rows;
}
