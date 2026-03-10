import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';

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
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const priority = (url.searchParams.get('priority') ?? 'stale') as CrawlPriority;
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
  const community = url.searchParams.get('community') ?? null;
  const campId = url.searchParams.get('campId') ?? null;
  const q = url.searchParams.get('q') ?? null;

  const pool = getPool();

  // --- Batch lookup by IDs (for retry) ---
  const ids = url.searchParams.get('ids');
  if (ids) {
    const idList = ids.split(',').filter(Boolean);
    const result = await pool.query(`
      SELECT
        id, name, "communitySlug", "websiteUrl", "dataConfidence", "registrationStatus",
        "lastVerifiedAt",
        (CASE WHEN description = '' OR description IS NULL THEN 1 ELSE 0 END +
         CASE WHEN neighborhood = '' OR neighborhood IS NULL THEN 1 ELSE 0 END +
         CASE WHEN "registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
        0 AS "priorityScore"
      FROM "Camp"
      WHERE id = ANY($1)
    `, [idList]);
    return NextResponse.json({ camps: result.rows as CrawlPreviewCamp[], totalCrawlable: result.rows.length });
  }

  // --- Single camp lookup by ID ---
  if (campId) {
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
    `, [campId]);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`
    );

    return NextResponse.json({
      camps: result.rows as CrawlPreviewCamp[],
      totalCrawlable: countResult.rows[0].total,
    });
  }

  // --- Text search (priority=specific with q=<query>) ---
  if (priority === 'specific' && q) {
    const searchLimit = Math.min(limit, 10);
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
      ORDER BY name ASC
      LIMIT $2
    `, [`%${q}%`, searchLimit]);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`
    );

    return NextResponse.json({
      camps: result.rows as CrawlPreviewCamp[],
      totalCrawlable: countResult.rows[0].total,
    });
  }

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
  } else if (priority === 'missing') {
    whereClause += ` AND (description = '' OR description IS NULL OR neighborhood = '' OR neighborhood IS NULL OR "registrationStatus" = 'UNKNOWN')`;
  }

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
