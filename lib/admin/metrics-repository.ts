import { getPool } from '@/lib/db';
import type { LLMExtractionResult } from './types';

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
