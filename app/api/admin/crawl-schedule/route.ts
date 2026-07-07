/**
 * app/api/admin/crawl-schedule/route.ts — admin GET/PATCH for the singleton
 * `CrawlSchedule` row (campfit#92, Wave 2).
 *
 * Admin-only (no `allowModerator`): the schedule is a single global toggle
 * (see `lib/admin/schedule-repository.ts` / `016_crawl_schedule.sql` — no
 * `communitySlug` column, explicitly out of scope), not something scoped to
 * one moderator's community, so it follows the `requireAdminAccess()`
 * no-args admin-only precedent (`app/api/admin/site-hints/route.ts`,
 * `app/api/admin/users/route.ts`), not the `{ allowModerator: true }` one.
 *
 * `lastRun` is derived live from `CrawlRun` (never a second stored copy —
 * avoids the `#98`-class drift risk of two sources of truth); `nextRun` is
 * plain `Date` arithmetic against the fixed cron hour `vercel.json`'s
 * `/api/cron/crawl` entry runs on (Wave 2's cron-route task) — no new
 * cron-parsing dependency for a single fixed daily hour.
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getSchedule, updateSchedule, type CrawlSchedulePriority } from '@/lib/admin/schedule-repository';
import type { CrawlRun } from '@/lib/admin/types';

export const dynamic = 'force-dynamic';

/**
 * Fixed daily cron hour (UTC) that `vercel.json`'s `/api/cron/crawl` entry
 * (`0 9 * * *`, Wave 2) runs on. A plain constant, not parsed from the cron
 * string itself — matches the plan's explicit "no new cron-parsing
 * dependency" decision. If Wave 2's cron hour ever changes, this constant
 * must be updated to match.
 */
const CRON_HOUR_UTC = 9;

/** Cron-automation vocabulary only — matches `CrawlSchedulePriority` and the
 * plan's explicit restriction (never 'all'/'missing'/'coming_soon'/'specific'). */
const VALID_PRIORITIES: CrawlSchedulePriority[] = ['stale', 'never_crawled'];

/** Serverless-limit ceiling per the plan's batch-size math — 10 is the
 * largest allowed value (nothing above it is accepted, even though
 * `crawl-modal.tsx`'s own `LIMIT_OPTIONS` goes higher for manual runs). */
const VALID_BATCH_SIZES = [5, 10];

function computeNextRun(from: Date): string {
  const next = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    CRON_HOUR_UTC,
    0,
    0,
    0,
  ));
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

async function getLastScheduledRun(): Promise<CrawlRun | null> {
  const pool = getPool();
  const result = await pool.query<CrawlRun>(
    `SELECT * FROM "CrawlRun" WHERE trigger = 'SCHEDULED' ORDER BY "startedAt" DESC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function GET() {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [schedule, lastRun] = await Promise.all([
    getSchedule(),
    getLastScheduledRun(),
  ]);

  return NextResponse.json({
    schedule,
    lastRun,
    nextRun: computeNextRun(new Date()),
  });
}

export async function PATCH(request: Request) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({}));
  const patch: {
    enabled?: boolean;
    priority?: CrawlSchedulePriority;
    batchSize?: number;
    updatedBy?: string;
  } = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    patch.enabled = body.enabled;
  }

  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(body.priority)) {
      return NextResponse.json(
        { error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` },
        { status: 400 },
      );
    }
    patch.priority = body.priority;
  }

  if (body.batchSize !== undefined) {
    if (!VALID_BATCH_SIZES.includes(body.batchSize)) {
      return NextResponse.json(
        { error: `batchSize must be one of: ${VALID_BATCH_SIZES.join(', ')}` },
        { status: 400 },
      );
    }
    patch.batchSize = body.batchSize;
  }

  patch.updatedBy = auth.access.email;

  const schedule = await updateSchedule(patch);
  const lastRun = await getLastScheduledRun();

  return NextResponse.json({
    schedule,
    lastRun,
    nextRun: computeNextRun(new Date()),
  });
}
