import { getPool } from '@/lib/db';
import { campfitVocabulary } from '@/lib/trust-vocabulary';
import { REQUIRED_FOR_VERIFIED } from './verification';
import { communityScopeSql } from './community-access';
import type { FieldDiff, LLMExtractionResult, ProposedChanges } from './types';

export interface VerifiedCoverageMetric {
  /** Total camps in scope. */
  total: number;
  /** Camps whose every REQUIRED_FOR_VERIFIED field is attested. */
  verified: number;
  /** Integer percent (0–100) of camps fully verified; 0 when total is 0. */
  pct: number;
}

/**
 * Site-wide roll-up of the per-camp CoverageMeter: the count and % of camps
 * whose data is fully verified — the user-acquisition gate metric (R3/AC3).
 *
 * A camp counts as verified iff EVERY `REQUIRED_FOR_VERIFIED` field has an
 * attestation (`fieldSources[field].approvedAt`) — the exact `isFullyVerified()`
 * rule (lib/admin/verification.ts), evaluated in SQL over `Camp.fieldSources`
 * so it needs no schema migration and stays in lock-step with the badge and
 * the approve gate. The field list is the same compile-time constant, so the
 * metric can never drift from the definition of "verified" it reports on.
 *
 * Pass a moderator's community slugs to scope the figure; omit for the
 * site-wide (admin) number.
 */
export async function getVerifiedCoverageMetric(
  communitySlugs?: string[],
): Promise<VerifiedCoverageMetric> {
  const pool = getPool();
  const scope = communityScopeSql(communitySlugs, 'c."communitySlug"', 1);

  // REQUIRED_FOR_VERIFIED is a compile-time constant whitelist of identifiers —
  // safe to interpolate into the JSON path. Each `#>> '{field,approvedAt}'`
  // returns the attestation timestamp as text, or NULL when unattested.
  const allAttested = REQUIRED_FOR_VERIFIED
    .map((field) => `(c."fieldSources" #>> '{${field},approvedAt}') IS NOT NULL`)
    .join(' AND ');

  const { rows } = await pool.query<{ total: number; verified: number }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE ${allAttested})::int AS verified
     FROM "Camp" c
     WHERE 1=1${scope.clause}`,
    scope.values as unknown[],
  );

  const total = Number(rows[0]?.total ?? 0);
  const verified = Number(rows[0]?.verified ?? 0);
  return {
    total,
    verified,
    pct: total > 0 ? Math.round((verified / total) * 100) : 0,
  };
}

export async function recordExtractionMetrics(opts: {
  runId: string;
  campId: string;
  siteHost: string;
  result: LLMExtractionResult;
  changesFound: number;
  durationMs: number;
}): Promise<void> {
  const pool = getPool();
  const { runId, campId, siteHost, result, changesFound, durationMs } = opts;

  const metrics: { name: string; value: number; dims: Record<string, string> }[] = [
    { name: 'extraction_confidence', value: result.overallConfidence, dims: { campId, siteHost } },
    { name: 'extraction_duration_ms', value: durationMs, dims: { campId, siteHost } },
    { name: 'changes_found', value: changesFound, dims: { campId } },
    { name: 'site_fetch_success', value: result.error ? 0 : 1, dims: { siteHost } },
    { name: 'tokens_used', value: result.tokensUsed, dims: { campId } },
  ];

  // Per-field confidence
  for (const [field, conf] of Object.entries(result.confidence)) {
    metrics.push({ name: 'field_confidence', value: conf, dims: { campId, field, siteHost } });
  }

  for (const m of metrics) {
    await pool.query(
      `INSERT INTO "CrawlMetric" ("crawlRunId", "metricName", "metricValue", dimensions)
       VALUES ($1, $2, $3, $4)`,
      [runId, m.name, m.value, JSON.stringify(m.dims)]
    );
  }
}

export async function recordReviewDecision(opts: {
  proposalId: string;
  runId: string | null;
  approvedFields: string[];
  rejectedFields: string[];
  proposedChanges?: ProposedChanges;
  reviewerNotes?: string | null;
  feedbackTags?: string[];
  extractionModel?: string;
  overallConfidence?: number;
  finalDecision?: boolean;
}): Promise<void> {
  const pool = getPool();
  const allFields = [
    ...opts.approvedFields.map(f => ({ field: f, approved: true })),
    ...opts.rejectedFields.map(f => ({ field: f, approved: false })),
  ];
  for (const { field, approved } of allFields) {
    await pool.query(
      `INSERT INTO "CrawlMetric" ("crawlRunId", "metricName", "metricValue", dimensions)
       VALUES ($1, $2, 1, $3)`,
      [
        opts.runId,
        approved ? 'field_approved' : 'field_rejected',
        JSON.stringify({ field, proposalId: opts.proposalId }),
      ]
    );
  }

  if (opts.finalDecision && opts.proposedChanges) {
    for (const field of opts.rejectedFields) {
      const diff = opts.proposedChanges[field];
      if (!diff) continue;

      await pool.query(
        `INSERT INTO "CrawlMetric" ("crawlRunId", "metricName", "metricValue", dimensions)
         VALUES ($1, 'field_rejection_learning_signal', 1, $2)`,
        [
          opts.runId,
          JSON.stringify(buildRejectedProposalLearningDimensions({
            proposalId: opts.proposalId,
            field,
            diff,
            reviewerNotes: opts.reviewerNotes,
            feedbackTags: opts.feedbackTags,
            extractionModel: opts.extractionModel,
            overallConfidence: opts.overallConfidence,
          })),
        ],
      );
    }
  }
}

// SKIP decision (survey 1.x adoption): NOT adopting Survey's
// buildSurveyLearningProjections here. That helper produces an in-memory
// LearningProjection[] audit trail from a SurveyInput; this field_rejection_learning_signal
// is a persisted SQL row in the shared CrawlMetric table, aggregated by
// getDashboardMetrics()'s GROUP BY/time-window queries — a different consumption
// shape with no shipped BI/dashboard equivalent. Forcing adoption would mean a
// dual write with no consumer, or rewriting the SQL aggregation layer (out of
// scope for a dependency bump). See docs/survey-1.x-migration.md.
export function buildRejectedProposalLearningDimensions(opts: {
  proposalId: string;
  field: string;
  diff: FieldDiff;
  reviewerNotes?: string | null;
  feedbackTags?: string[];
  extractionModel?: string;
  overallConfidence?: number;
}): Record<string, string> {
  return compactStringRecord({
    proposalId: opts.proposalId,
    field: opts.field,
    decisionEffect: campfitVocabulary.decisionEffects.keptCurrentValue,
    sourceUrl: opts.diff.sourceUrl,
    excerpt: opts.diff.excerpt,
    proposedValue: summarizeMetricValue(opts.diff.new),
    currentValue: summarizeMetricValue(opts.diff.old),
    confidence: String(opts.diff.confidence),
    mode: opts.diff.mode,
    reviewerNotes: opts.reviewerNotes ?? undefined,
    feedbackTags: opts.feedbackTags?.join(','),
    extractionModel: opts.extractionModel,
    overallConfidence: opts.overallConfidence === undefined ? undefined : String(opts.overallConfidence),
  });
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''),
  );
}

function summarizeMetricValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (raw === undefined) return 'undefined';
  return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
}

export async function getDashboardMetrics(): Promise<{
  approvalRate: number;
  avgConfidence: number;
  siteFailureRates: { host: string; failureRate: number; total: number }[];
  fieldRejectionRates: { field: string; rejectionRate: number; total: number }[];
}> {
  const pool = getPool();

  const [approvalResult, confidenceResult, siteResult, fieldResult] = await Promise.all([
    pool.query(`
      SELECT
        SUM(CASE WHEN "metricName" = 'field_approved' THEN "metricValue" ELSE 0 END) AS approved,
        SUM(CASE WHEN "metricName" = 'field_rejected' THEN "metricValue" ELSE 0 END) AS rejected
      FROM "CrawlMetric"
      WHERE "metricName" IN ('field_approved', 'field_rejected')
        AND "recordedAt" > now() - interval '30 days'
    `),
    pool.query(`
      SELECT AVG("metricValue") AS avg
      FROM "CrawlMetric"
      WHERE "metricName" = 'extraction_confidence'
        AND "recordedAt" > now() - interval '30 days'
    `),
    pool.query(`
      SELECT
        dimensions->>'siteHost' AS host,
        COUNT(*) AS total,
        SUM(CASE WHEN "metricValue" = 0 THEN 1 ELSE 0 END) AS failures
      FROM "CrawlMetric"
      WHERE "metricName" = 'site_fetch_success'
        AND "recordedAt" > now() - interval '30 days'
        AND dimensions->>'siteHost' IS NOT NULL
      GROUP BY host
      ORDER BY failures DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT
        dimensions->>'field' AS field,
        COUNT(*) AS total,
        SUM(CASE WHEN "metricName" = 'field_rejected' THEN 1 ELSE 0 END) AS rejections
      FROM "CrawlMetric"
      WHERE "metricName" IN ('field_approved', 'field_rejected')
        AND "recordedAt" > now() - interval '30 days'
        AND dimensions->>'field' IS NOT NULL
      GROUP BY field
      ORDER BY rejections DESC
      LIMIT 10
    `),
  ]);

  const { approved = 0, rejected = 0 } = approvalResult.rows[0] ?? {};
  const total = Number(approved) + Number(rejected);

  return {
    approvalRate: total > 0 ? Math.round((Number(approved) / total) * 100) / 100 : 0,
    avgConfidence: Math.round((Number(confidenceResult.rows[0]?.avg ?? 0)) * 100) / 100,
    siteFailureRates: siteResult.rows.map(r => ({
      host: r.host,
      total: Number(r.total),
      failureRate: Math.round((Number(r.failures) / Number(r.total)) * 100) / 100,
    })),
    fieldRejectionRates: fieldResult.rows.map(r => ({
      field: r.field,
      total: Number(r.total),
      rejectionRate: Math.round((Number(r.rejections) / Number(r.total)) * 100) / 100,
    })),
  };
}
