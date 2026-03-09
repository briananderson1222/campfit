import { getPool } from '@/lib/db';
import type { CrawlRun, CrawlCampLogEntry, CrawlStatus } from './types';

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
  updates: Partial<Pick<CrawlRun, 'processedCamps' | 'errorCount' | 'newProposals'>>
): Promise<void> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
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
