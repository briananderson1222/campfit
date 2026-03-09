import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

export type CrawlPriority = 'stale' | 'missing' | 'coming_soon' | 'never_crawled' | 'all';

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
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const priority = (url.searchParams.get('priority') ?? 'stale') as CrawlPriority;
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
  const community = url.searchParams.get('community') ?? null;

  const pool = getPool();

  // Base: only camps with a crawlable URL
  let whereClause = `"websiteUrl" IS NOT NULL AND "websiteUrl" != ''`;
  const params: unknown[] = [];

  if (community) {
    params.push(community);
    whereClause += ` AND "communitySlug" = $${params.length}`;
  }

  // Priority-specific filters
  if (priority === 'never_crawled') {
    whereClause += ` AND "lastVerifiedAt" IS NULL`;
  } else if (priority === 'coming_soon') {
    whereClause += ` AND "registrationStatus" = 'COMING_SOON'`;
  }

  const now = new Date().toISOString();

  const result = await pool.query(`
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
  `, [...params, limit]);

  // Total crawlable camps count
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''` +
    (community ? ` AND "communitySlug" = $1` : ''),
    community ? [community] : []
  );

  return NextResponse.json({
    camps: result.rows as CrawlPreviewCamp[],
    totalCrawlable: countResult.rows[0].total,
  });
}
