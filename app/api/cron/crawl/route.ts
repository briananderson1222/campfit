/**
 * GET /api/cron/crawl — scheduled batch-crawl invocation (campfit#92 Wave 2).
 *
 * Vercel Cron precedent: `app/api/cron/notify/route.ts:14-18`'s
 * `CRON_SECRET` bearer-auth check, reused verbatim here.
 *
 * Reads the singleton `CrawlSchedule` row (`lib/admin/schedule-repository.ts`,
 * Wave 1). If disabled, this is a normal no-op state (not a failure) — a
 * disabled schedule simply means "nothing to do today", so the response is
 * `200 { ran: false, reason: 'disabled' }`, never a non-2xx status.
 *
 * If enabled, resolves the candidate batch via
 * `resolveCrawlCandidates({ priority, limit: batchSize })`
 * (`lib/admin/crawl-priority.ts`, Wave 1 — restricted to the schedule's own
 * `'stale' | 'never_crawled'` vocabulary, never `'all'/'missing'/
 * 'coming_soon'/'specific'`) and calls `runCrawlPipeline({ campIds, trigger:
 * 'SCHEDULED', ... })` (the #85 seam, consumed as-is — no seam changes).
 *
 * Deliberately AWAITS the pipeline to completion before responding —
 * NOT `crawl/start/route.ts`'s fire-and-forget-after-runId pattern
 * (`app/api/admin/crawl/start/route.ts:28-54`). A cron invocation has no
 * follow-up request to keep the function warm, so the whole batch must
 * finish inside this one invocation's `maxDuration` window. Per the plan's
 * serverless-limit math (see `scheduled-crawls--plan.md`'s Plan section): a
 * 5-camp batch across up to 5 distinct domains worst-cases at
 * `ceil(5/3) = 2` sequential domain-waves × 60s fetch ceiling = 120s,
 * leaving 180s of the existing `maxDuration = 300` ceiling (same as the five
 * production re-crawl routes, e.g. `app/api/admin/scrape/route.ts`) for
 * extraction + diff + proposal writes — so awaiting fits comfortably.
 *
 * Deliberately does NOT write a `lastRunAt` field back onto the
 * `CrawlSchedule` row — the plan's `AC2` derives "last run" LIVE from the
 * most recent `CrawlRun` row with `trigger = 'SCHEDULED'` (read by the
 * admin schedule route, Wave 2's other task), never a second stored copy.
 * `prisma/migrations/016_crawl_schedule.sql` has no `lastRunAt` column by
 * the same design choice. This route's own responsibility ends at running
 * the batch and reporting the result; `CrawlRun` itself (written by the
 * seam's own tracker) is the only record of "when did a scheduled run last
 * happen".
 */

import { NextResponse } from 'next/server';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { getSchedule } from '@/lib/admin/schedule-repository';
import { resolveCrawlCandidates } from '@/lib/admin/crawl-priority';

export const maxDuration = 300; // same ceiling as the five existing re-crawl routes

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const schedule = await getSchedule();
  if (!schedule.enabled) {
    return NextResponse.json({ ran: false, reason: 'disabled' });
  }

  const candidates = await resolveCrawlCandidates({
    priority: schedule.priority,
    limit: schedule.batchSize,
  });
  const campIds = candidates.map((c) => c.id);

  const run = await runCrawlPipeline({
    campIds,
    triggeredBy: 'cron:scheduled-crawl',
    trigger: 'SCHEDULED',
    limit: schedule.batchSize,
  });

  return NextResponse.json({
    ran: true,
    runId: run.id,
    status: run.status,
    processedCamps: run.processedCamps,
    errorCount: run.errorCount,
    newProposals: run.newProposals,
  });
}
