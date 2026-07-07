/**
 * scripts/review-throughput-report.ts — AC5 (R5) reviews/hour measurement
 * (campfit#51, Wave 4 Task 4.1).
 *
 * Usage:
 *   npx tsx scripts/review-throughput-report.ts --since <ISO> --until <ISO>
 *
 * Prints, per hour-bucket in `[since, until)`:
 *   { hour, reviewsCompleted, fieldsApplied, fieldsRejected }
 * plus a summary `reviewsPerHour` average (total reviews completed in the
 * window, divided by the window's length in hours — NOT divided only by
 * hours with activity, so a sparse window doesn't inflate the rate).
 *
 * `reviewsCompleted` counts `CampChangeProposal` rows whose `reviewedAt`
 * falls in the bucket — set exactly once a Proposal FULLY leaves `PENDING`
 * (`updateProposalStatus`, called by both the interactive `applyProposalReview`
 * full-apply path and `applyBatchAcceptedClaims`'s full-apply path via
 * `transitionProposalStatus`); a `keepPending`/partial round (interactive OR
 * batch) does NOT set `reviewedAt` again (matches
 * `lib/admin/review-repository.ts`'s `partialApprove`, which updates
 * `appliedFields`/`priority` but not `reviewedAt`) — this is a deliberate,
 * documented reading of "review completed" as "fully resolved," not "any
 * partial round," matching the metric's own name.
 *
 * `fieldsApplied`/`fieldsRejected` read `CrawlMetric`'s `field_approved`/
 * `field_rejected` rows (`lib/admin/metrics-repository.ts`'s
 * `recordReviewDecision`, written identically by both the interactive and
 * batch-accept paths) bucketed by their own `recordedAt`, independent of
 * `reviewedAt` — this captures a partial round's field-level activity too,
 * which `reviewsCompleted` alone would miss.
 *
 * OWNER-ACTIVATED (AC5's real disposition, per the plan's Definition Of
 * Done): this script is built and runnable now; the REAL before/after
 * reviews/hour numbers are recorded by the repo owner — once before merge
 * (baseline, current single-accept-only backlog) and once after a real
 * post-merge batch-accept session on the live backlog — pasted into the
 * closure comment's Acceptance Evidence table. This planning/execution pass
 * does not, and cannot honestly, fabricate that real-world before/after
 * number against fixture data.
 *
 * Reuses `getPool()` (`lib/db.ts`) — no new DB client, matching
 * `metrics-repository.ts`'s own connection convention.
 */
import { getPool } from '@/lib/db';
import { loadLocalEnv } from './load-env';

loadLocalEnv();

interface HourBucketRow {
  hour: string;
  reviewsCompleted: number;
  fieldsApplied: number;
  fieldsRejected: number;
}

function parseArgs(argv: string[]): { since: string; until: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      const key = argv[i]!.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args.set(key, value);
        i++;
      }
    }
  }

  const since = args.get('since');
  const until = args.get('until');
  if (!since || !until) {
    throw new Error(
      'Usage: npx tsx scripts/review-throughput-report.ts --since <ISO> --until <ISO>\n' +
        'Both --since and --until are required (ISO-8601 timestamps, e.g. 2026-07-01T00:00:00Z).',
    );
  }
  if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    throw new Error(`--since/--until must both be parseable ISO-8601 timestamps; got --since=${since} --until=${until}`);
  }
  if (Date.parse(until) <= Date.parse(since)) {
    throw new Error(`--until (${until}) must be after --since (${since}).`);
  }
  return { since, until };
}

export async function buildThroughputReport(opts: { since: string; until: string }): Promise<{
  rows: HourBucketRow[];
  reviewsPerHour: number;
  totalReviewsCompleted: number;
  windowHours: number;
}> {
  const pool = getPool();

  const [reviewsResult, fieldsResult] = await Promise.all([
    pool.query<{ hour: Date; reviews_completed: string }>(
      `SELECT date_trunc('hour', "reviewedAt") AS hour, COUNT(*) AS reviews_completed
       FROM "CampChangeProposal"
       WHERE "reviewedAt" >= $1 AND "reviewedAt" < $2
       GROUP BY 1
       ORDER BY 1`,
      [opts.since, opts.until],
    ),
    pool.query<{ hour: Date; fields_applied: string; fields_rejected: string }>(
      `SELECT date_trunc('hour', "recordedAt") AS hour,
              SUM(CASE WHEN "metricName" = 'field_approved' THEN "metricValue" ELSE 0 END) AS fields_applied,
              SUM(CASE WHEN "metricName" = 'field_rejected' THEN "metricValue" ELSE 0 END) AS fields_rejected
       FROM "CrawlMetric"
       WHERE "metricName" IN ('field_approved', 'field_rejected')
         AND "recordedAt" >= $1 AND "recordedAt" < $2
       GROUP BY 1
       ORDER BY 1`,
      [opts.since, opts.until],
    ),
  ]);

  const byHour = new Map<string, HourBucketRow>();
  for (const row of reviewsResult.rows) {
    const hour = row.hour.toISOString();
    byHour.set(hour, { hour, reviewsCompleted: Number(row.reviews_completed), fieldsApplied: 0, fieldsRejected: 0 });
  }
  for (const row of fieldsResult.rows) {
    const hour = row.hour.toISOString();
    const existing = byHour.get(hour) ?? { hour, reviewsCompleted: 0, fieldsApplied: 0, fieldsRejected: 0 };
    existing.fieldsApplied = Number(row.fields_applied);
    existing.fieldsRejected = Number(row.fields_rejected);
    byHour.set(hour, existing);
  }

  const rows = Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  const totalReviewsCompleted = rows.reduce((sum, row) => sum + row.reviewsCompleted, 0);
  const windowHours = Math.max(1, (Date.parse(opts.until) - Date.parse(opts.since)) / (60 * 60 * 1000));

  return {
    rows,
    reviewsPerHour: Math.round((totalReviewsCompleted / windowHours) * 100) / 100,
    totalReviewsCompleted,
    windowHours: Math.round(windowHours * 100) / 100,
  };
}

async function main() {
  const { since, until } = parseArgs(process.argv.slice(2));
  const report = await buildThroughputReport({ since, until });

  console.log(`Review throughput report: ${since} .. ${until} (${report.windowHours}h window)`);
  console.log('');
  for (const row of report.rows) {
    console.log(
      `${row.hour}  reviewsCompleted=${row.reviewsCompleted}  fieldsApplied=${row.fieldsApplied}  fieldsRejected=${row.fieldsRejected}`,
    );
  }
  console.log('');
  console.log(`Total reviews completed: ${report.totalReviewsCompleted}`);
  console.log(`Reviews/hour (window average): ${report.reviewsPerHour}`);
}

const isDirectRun = process.argv[1]?.endsWith('review-throughput-report.ts');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
