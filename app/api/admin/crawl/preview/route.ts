import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { resolveCrawlCandidates, type CrawlCandidatePriority } from '@/lib/admin/crawl-priority';

export type CrawlPriority = 'stale' | 'missing' | 'coming_soon' | 'never_crawled' | 'all' | 'specific';

export interface CrawlPreviewCamp {
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const priority = (url.searchParams.get('priority') ?? 'stale') as CrawlPriority;
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
  const community = url.searchParams.get('community') ?? null;
  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const campId = url.searchParams.get('campId') ?? null;
  const q = url.searchParams.get('q') ?? null;
  const scopedCommunities = auth.access.isAdmin ? null : auth.access.communities;

  const pool = getPool();

  // --- Batch lookup by IDs (for retry) ---
  const ids = url.searchParams.get('ids');
  if (ids) {
    const idList = ids.split(',').filter(Boolean);
    const communityFilter = scopedCommunities ? ` AND "communitySlug" = ANY($2::text[])` : '';
    const result = await pool.query(`
      SELECT
        id, name, "communitySlug", "websiteUrl", "dataConfidence", "registrationStatus",
        "lastVerifiedAt",
        (CASE WHEN description = '' OR description IS NULL THEN 1 ELSE 0 END +
         CASE WHEN neighborhood = '' OR neighborhood IS NULL THEN 1 ELSE 0 END +
         CASE WHEN "registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
        0 AS "priorityScore"
      FROM "Camp"
      WHERE id = ANY($1)${communityFilter}
    `, scopedCommunities ? [idList, scopedCommunities] : [idList]);
    return NextResponse.json({ camps: result.rows as CrawlPreviewCamp[], totalCrawlable: result.rows.length });
  }

  // --- Single camp lookup by ID ---
  if (campId) {
    const communityFilter = scopedCommunities ? ` AND "communitySlug" = ANY($2::text[])` : '';
    const result = await pool.query(`
      SELECT
        id, name, "communitySlug", "websiteUrl", "dataConfidence", "registrationStatus",
        "lastVerifiedAt",
        (CASE WHEN description = '' OR description IS NULL THEN 1 ELSE 0 END +
         CASE WHEN neighborhood = '' OR neighborhood IS NULL THEN 1 ELSE 0 END +
         CASE WHEN "registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
        0 AS "priorityScore"
      FROM "Camp"
      WHERE id = $1 AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''
      ${communityFilter}
    `, scopedCommunities ? [campId, scopedCommunities] : [campId]);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''` +
      (scopedCommunities ? ` AND "communitySlug" = ANY($1::text[])` : ''),
      scopedCommunities ? [scopedCommunities] : [],
    );

    return NextResponse.json({
      camps: result.rows as CrawlPreviewCamp[],
      totalCrawlable: countResult.rows[0].total,
    });
  }

  // --- Text search (priority=specific with q=<query>) ---
  if (priority === 'specific' && q) {
    const searchLimit = Math.min(limit, 10);
    const communityFilter = scopedCommunities ? ` AND "communitySlug" = ANY($3::text[])` : '';
    const result = await pool.query(`
      SELECT
        id, name, "communitySlug", "websiteUrl", "dataConfidence", "registrationStatus",
        "lastVerifiedAt",
        (CASE WHEN description = '' OR description IS NULL THEN 1 ELSE 0 END +
         CASE WHEN neighborhood = '' OR neighborhood IS NULL THEN 1 ELSE 0 END +
         CASE WHEN "registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
        0 AS "priorityScore"
      FROM "Camp"
      WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''
        AND name ILIKE $1
        ${communityFilter}
      ORDER BY name ASC
      LIMIT $2
    `, scopedCommunities ? [`%${q}%`, searchLimit, scopedCommunities] : [`%${q}%`, searchLimit]);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''` +
      (scopedCommunities ? ` AND "communitySlug" = ANY($1::text[])` : ''),
      scopedCommunities ? [scopedCommunities] : [],
    );

    return NextResponse.json({
      camps: result.rows as CrawlPreviewCamp[],
      totalCrawlable: countResult.rows[0].total,
    });
  }

  // Base: priority-driven resolution (stale/missing/coming_soon/never_crawled/
  // all/specific-without-q — the latter behaves like 'all', matching
  // pre-extraction behavior where it fell through every priority-specific
  // branch below unmatched). Extracted to `resolveCrawlCandidates`
  // (lib/admin/crawl-priority.ts) — same SQL, same ordering, same output
  // shape as before this refactor; also called directly by the scheduled
  // cron route (campfit#92) so the two callers share one implementation.
  const candidates = await resolveCrawlCandidates({
    priority: priority as CrawlCandidatePriority,
    limit,
    communitySlug: community ?? scopedCommunities,
  });

  // Total crawlable camps count
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''` +
    (community ? ` AND "communitySlug" = $1` : ''),
    community
      ? [community]
      : scopedCommunities
        ? [scopedCommunities]
        : []
  );

  return NextResponse.json({
    camps: candidates as CrawlPreviewCamp[],
    totalCrawlable: countResult.rows[0].total,
  });
}
