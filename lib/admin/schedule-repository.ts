/**
 * lib/admin/schedule-repository.ts — persistence for the singleton
 * `CrawlSchedule` row (campfit#92, Wave 1).
 *
 * `prisma/migrations/016_crawl_schedule.sql` guarantees exactly one row
 * (`id = 'default'`) always exists (bootstrap `INSERT ... ON CONFLICT DO
 * NOTHING` + a `CHECK` constraint pinning the id) — so `getSchedule()` never
 * returns null and no caller needs a "no schedule yet" branch.
 *
 * `updateSchedule` follows `crawl-repository.ts`'s `updateCrawlRunProgress`
 * dynamic partial-SET-clause pattern: only the fields present in `patch`
 * are written.
 */
import { getPool } from '@/lib/db';
import type { CrawlRun } from './types';

/** Cron-automation vocabulary only — mirrors the plan's explicit restriction
 * (never 'all'/'missing'/'coming_soon'/'specific'/'onboard_url', which need
 * human judgment or free-text input). Validation of this restriction lives
 * at the API-route boundary (Wave 2), not here — this module persists
 * whatever valid value it's given. */
export type CrawlSchedulePriority = 'stale' | 'never_crawled';

export interface CrawlSchedule {
  id: string;
  enabled: boolean;
  priority: CrawlSchedulePriority;
  batchSize: number;
  updatedAt: string;
  updatedBy: string | null;
}

const SCHEDULE_ID = 'default';

export async function getLastScheduledRun(): Promise<CrawlRun | null> {
  const pool = getPool();
  const result = await pool.query<CrawlRun>(
    `SELECT * FROM "CrawlRun" WHERE trigger = 'SCHEDULED' ORDER BY "startedAt" DESC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

/** Always returns the singleton row — never null, given the migration's bootstrap insert. */
export async function getSchedule(): Promise<CrawlSchedule> {
  const pool = getPool();
  const result = await pool.query<CrawlSchedule>(
    `SELECT * FROM "CrawlSchedule" WHERE id = $1`,
    [SCHEDULE_ID]
  );
  const row = result.rows[0];
  if (!row) {
    // Defense-in-depth only: the migration's bootstrap INSERT should make
    // this unreachable in any database provisioned by 016_crawl_schedule.sql.
    throw new Error(
      'CrawlSchedule row is missing — the "default" singleton row should ' +
        'always exist (see prisma/migrations/016_crawl_schedule.sql). Has ' +
        'that migration been applied?'
    );
  }
  return row;
}

export async function updateSchedule(patch: {
  enabled?: boolean;
  priority?: CrawlSchedulePriority;
  batchSize?: number;
  updatedBy?: string | null;
}): Promise<CrawlSchedule> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled); }
  if (patch.priority !== undefined) { sets.push(`priority = $${i++}`); vals.push(patch.priority); }
  if (patch.batchSize !== undefined) { sets.push(`"batchSize" = $${i++}`); vals.push(patch.batchSize); }
  if (patch.updatedBy !== undefined) { sets.push(`"updatedBy" = $${i++}`); vals.push(patch.updatedBy); }
  // "updatedAt" always advances on any patch call, even a no-field-changed
  // no-op, so it reflects "last touched", not just "last value-changed".
  sets.push(`"updatedAt" = now()`);
  vals.push(SCHEDULE_ID);
  const result = await pool.query<CrawlSchedule>(
    `UPDATE "CrawlSchedule" SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      'CrawlSchedule row is missing — updateSchedule() found no "default" ' +
        'row to update (see prisma/migrations/016_crawl_schedule.sql).'
    );
  }
  return row;
}
