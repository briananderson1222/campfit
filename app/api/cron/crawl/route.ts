/**
 * GET /api/cron/crawl — scheduled batch-crawl invocation (campfit#92 Wave 2).
 *
 * Vercel Cron precedent: `app/api/cron/notify/route.ts:14-18`'s
 * `CRON_SECRET` bearer-auth check was the original template for this route's
 * auth. Per campfit#92 code review's MEDIUM finding, this route now
 * deliberately HARDENS beyond that precedent (see `isAuthorizedCronRequest`
 * below) — `notify/route.ts` and `app/api/admin/scrape/route.ts` are left
 * on the original plain-`!==` comparison on purpose: rewriting three routes'
 * auth in a PR that isn't about auth hardening would be a bigger, less
 * honest change than fixing the one route this PR actually touches. A
 * follow-up should bring the other two in line with the same helper.
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
 * Wrapped in a top-level `try/catch` (campfit#92 code review's MEDIUM
 * finding: this previously had no guard, so a resolver/pipeline throw would
 * propagate as an unhandled rejection into Next.js's own default 500) — any
 * exception from `getSchedule()`/`resolveCrawlCandidates()`/
 * `runCrawlPipeline()` degrades to an explicit `500 { error }` response
 * instead, matching this repo's other explicit-500 error shapes (e.g.
 * `app/api/admin/scrape/route.ts`'s `DatumError` branch).
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

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { getSchedule } from '@/lib/admin/schedule-repository';
import { resolveCrawlCandidates } from '@/lib/admin/crawl-priority';

export const maxDuration = 300; // same ceiling as the five existing re-crawl routes

/**
 * Fail-closed, timing-safe bearer-token check for this route only (see the
 * file doc above for why the other two `CRON_SECRET` call sites are left
 * unchanged). Two hardenings over the `authHeader !== \`Bearer ${secret}\`\`
 * precedent:
 *
 *  1. Fails CLOSED if `CRON_SECRET` is unset. A plain `!==` comparison
 *     degrades to comparing against the literal string `"Bearer undefined"`
 *     when the env var is missing — a caller sending that literal header
 *     would authenticate. This never proceeds past that check when the
 *     secret isn't configured, and logs loudly so a misconfigured deploy is
 *     obvious rather than silently exploitable.
 *  2. Uses `crypto.timingSafeEqual` instead of `!==` once both sides are
 *     known, length-equal buffers, so a wrong-secret guess can't be timed
 *     byte-by-byte against the real one. `timingSafeEqual` throws on a
 *     length mismatch (rather than returning `false`), so the length check
 *     happens first and short-circuits to `false` on any mismatch.
 */
function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron/crawl] CRON_SECRET is not set — refusing all requests (fail closed)');
    return false;
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;

  const actual = Buffer.from(authHeader);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length) return false;

  return timingSafeEqual(actual, expectedBuf);
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
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
  } catch (err) {
    console.error('[cron/crawl] scheduled crawl failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Scheduled crawl failed' },
      { status: 500 },
    );
  }
}
