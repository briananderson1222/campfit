import { getPool } from '@/lib/db';
import type { CrawlRun, CrawlCampLogEntry, CrawlStatus } from './types';

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

export async function getCampCrawlTarget(campId: string): Promise<{ id: string; websiteUrl: string | null } | undefined> {
  const { rows } = await getPool().query<{ id: string; websiteUrl: string | null }>(
    `SELECT id, "websiteUrl" FROM "Camp" WHERE id = $1`,
    [campId]
  );
  return rows[0];
}

/** A crawl query hit a column that only exists after a migration this database has not had. */
export class CrawlSchemaOutdatedError extends Error {
  constructor(cause: unknown) {
    super(
      'The database is missing crawl-state columns (migration 022_camp_crawl_attempt_and_content_digest). '
      + 'Run `npm run db:migrate` against this database, then crawl again.',
      { cause },
    );
    this.name = 'CrawlSchemaOutdatedError';
  }

  /** Set once a FAILED run was written for this error, so it is not recorded twice. */
  recorded = false;
}

/** Postgres `undefined_column`. Rethrown as {@link CrawlSchemaOutdatedError} so the operator is told what to do. */
export function asCrawlSchemaError(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code === '42703' ? new CrawlSchemaOutdatedError(err) : err;
}

/**
 * Leave a FAILED run on record for a crawl that could not even start, so the
 * failure shows in the crawl monitor instead of only in a server log.
 * Best-effort: never throws.
 */
export async function recordUnstartedCrawlFailure(opts: {
  triggeredBy: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  campIds?: string[];
  error: string;
}): Promise<void> {
  try {
    const run = await createCrawlRun({ triggeredBy: opts.triggeredBy, trigger: opts.trigger, campIds: opts.campIds, totalCamps: 0 });
    await completeCrawlRun(run.id, 'FAILED', [{ campId: 'run', url: '', error: opts.error }]);
  } catch (err) {
    console.error(`[crawl] could not record the failed start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function getLatestCrawlRunsForAdmin(): Promise<CrawlRun[]> {
  const result = await getPool().query<CrawlRun>(
    `SELECT * FROM "CrawlRun" ORDER BY "startedAt" DESC LIMIT 50`
  );
  return result.rows;
}

export async function getCampNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
  const camps = await getPool().query<{ id: string; name: string }>(
    `SELECT id, name FROM "Camp" WHERE id = ANY($1)`, [ids]
  );
  return camps.rows;
}

export async function getCrawlPreviewCampsByIds(
  idList: string[],
  scopedCommunities: string[] | null,
): Promise<CrawlPreviewCamp[]> {
  const communityFilter = scopedCommunities ? ` AND "communitySlug" = ANY($2::text[])` : '';
  const result = await getPool().query<CrawlPreviewCamp>(`
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
  return result.rows;
}

export async function getCrawlPreviewCampById(
  campId: string,
  scopedCommunities: string[] | null,
): Promise<CrawlPreviewCamp[]> {
  const communityFilter = scopedCommunities ? ` AND "communitySlug" = ANY($2::text[])` : '';
  const result = await getPool().query<CrawlPreviewCamp>(`
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
  return result.rows;
}

export async function searchCrawlPreviewCamps(
  query: string,
  searchLimit: number,
  scopedCommunities: string[] | null,
): Promise<CrawlPreviewCamp[]> {
  const communityFilter = scopedCommunities ? ` AND "communitySlug" = ANY($3::text[])` : '';
  const result = await getPool().query<CrawlPreviewCamp>(`
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
    `, scopedCommunities ? [`%${query}%`, searchLimit, scopedCommunities] : [`%${query}%`, searchLimit]);
  return result.rows;
}

export async function countCrawlableCampsForCommunities(scopedCommunities: string[] | null): Promise<number> {
  const countResult = await getPool().query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''` +
    (scopedCommunities ? ` AND "communitySlug" = ANY($1::text[])` : ''),
    scopedCommunities ? [scopedCommunities] : [],
  );
  return countResult.rows[0].total;
}

export async function countCrawlableCampsForCommunity(
  community: string | null,
  scopedCommunities: string[] | null,
): Promise<number> {
  const countResult = await getPool().query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''` +
    (community ? ` AND "communitySlug" = $1` : ''),
    community
      ? [community]
      : scopedCommunities
        ? [scopedCommunities]
        : []
  );
  return countResult.rows[0].total;
}

export async function createCrawlRun(opts: {
  triggeredBy: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  campIds?: string[];
  totalCamps: number;
}): Promise<CrawlRun> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "campIds", "totalCamps")
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [opts.triggeredBy, opts.trigger, opts.campIds ?? null, opts.totalCamps]
  );
  return result.rows[0];
}

export async function updateCrawlRunProgress(
  id: string,
  updates: Partial<Pick<CrawlRun, 'processedCamps' | 'errorCount' | 'newProposals' | 'totalCamps'>>
): Promise<void> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (updates.totalCamps !== undefined) { sets.push(`"totalCamps" = $${i++}`); vals.push(updates.totalCamps); }
  if (updates.processedCamps !== undefined) { sets.push(`"processedCamps" = $${i++}`); vals.push(updates.processedCamps); }
  if (updates.errorCount !== undefined) { sets.push(`"errorCount" = $${i++}`); vals.push(updates.errorCount); }
  if (updates.newProposals !== undefined) { sets.push(`"newProposals" = $${i++}`); vals.push(updates.newProposals); }
  if (sets.length === 0) return;
  vals.push(id);
  await pool.query(`UPDATE "CrawlRun" SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

export async function completeCrawlRun(
  id: string,
  status: CrawlStatus,
  errorLog: { campId: string; error: string; url: string }[]
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE "CrawlRun" SET status = $1, "completedAt" = now(), "errorLog" = $2 WHERE id = $3`,
    [status, JSON.stringify(errorLog), id]
  );
}

/**
 * How long a RUNNING run may go without recording progress before it is
 * treated as dead. A run's process can be killed without a chance to write its
 * final status (a serverless function hitting its time limit, a crash, a
 * deploy), which would otherwise leave the row RUNNING forever. Well above the
 * slowest observed single-camp extraction, so a live run is not reaped.
 */
export const STALE_CRAWL_RUN_MS = 30 * 60 * 1000;

/**
 * Mark RUNNING runs with no progress for `staleAfterMs` as FAILED. Progress is
 * the newest camp-log entry, or the start time when nothing was logged. Called
 * when a new run starts, so no scheduler or background job is needed.
 *
 * A late completion wins: a run that was only slow and later finishes
 * overwrites FAILED with the status it actually reached, because that status
 * is the true one. The note stays in its error log.
 */
export async function failStaleCrawlRuns(staleAfterMs: number = STALE_CRAWL_RUN_MS): Promise<string[]> {
  const pool = getPool();
  const note = [{
    campId: 'run',
    url: '',
    error: `Run recorded no progress for over ${Math.round(staleAfterMs / 60000)} minute(s) and never finished; its process likely crashed or was stopped. Marked FAILED when a later run started.`,
  }];
  const result = await pool.query<{ id: string }>(
    `UPDATE "CrawlRun" r
        SET status = 'FAILED', "completedAt" = now(), "errorLog" = COALESCE(r."errorLog", '[]'::jsonb) || $2::jsonb
      WHERE r.status = 'RUNNING'
        AND COALESCE(
              (SELECT max((entry->>'processedAt')::timestamptz) FROM jsonb_array_elements(r."campLog") AS entry),
              r."startedAt"
            ) < now() - ($1::double precision * interval '1 millisecond')
      RETURNING r.id`,
    [staleAfterMs, JSON.stringify(note)]
  );
  return result.rows.map((row) => row.id);
}

export async function getCrawlRun(id: string): Promise<CrawlRun | null> {
  const pool = getPool();
  const result = await pool.query(`SELECT * FROM "CrawlRun" WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function getRecentCrawlRuns(limit = 10): Promise<CrawlRun[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM "CrawlRun" ORDER BY "startedAt" DESC LIMIT $1`, [limit]
  );
  return result.rows;
}

export async function appendCrawlError(
  id: string,
  entry: { campId: string; error: string; url: string }
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE "CrawlRun" SET "errorLog" = "errorLog" || $1::jsonb WHERE id = $2`,
    [JSON.stringify([entry]), id]
  );
}

export async function appendCrawlLog(
  id: string,
  entry: CrawlCampLogEntry
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE "CrawlRun" SET "campLog" = "campLog" || $1::jsonb WHERE id = $2`,
    [JSON.stringify([entry]), id]
  );
}
