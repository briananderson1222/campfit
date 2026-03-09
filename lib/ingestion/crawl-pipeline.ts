import { getPool } from '@/lib/db';
import { extractCampDataFromUrl } from './llm-extractor';
import { computeDiff, computeOverallConfidence } from './diff-engine';
import { createCrawlRun, updateCrawlRunProgress, completeCrawlRun, appendCrawlError, appendCrawlLog } from '@/lib/admin/crawl-repository';
import { createProposal } from '@/lib/admin/review-repository';
import { recordExtractionMetrics } from '@/lib/admin/metrics-repository';
import type { CrawlProgressEvent, CrawlRun } from '@/lib/admin/types';
import type { Camp } from '@/lib/types';

export interface CrawlOptions {
  triggeredBy: string;
  trigger?: 'MANUAL' | 'SCHEDULED';
  campIds?: string[];
  model?: string;
  onProgress?: (event: CrawlProgressEvent) => void | Promise<void>;
}

export async function runCrawlPipeline(options: CrawlOptions): Promise<CrawlRun> {
  const pool = getPool();
  const emit = options.onProgress ?? (() => {});

  // Fetch camps to crawl (scalar fields only — array relations are fetched separately per camp)
  const campsResult = await pool.query<Camp & { id: string; name: string; websiteUrl: string; communitySlug: string }>(
    options.campIds?.length
      ? `SELECT id, name, slug, "websiteUrl", "communitySlug", neighborhood, city, description,
               "campType", category, "registrationStatus", "registrationOpenDate", "lunchIncluded",
               address, "interestingDetails"
         FROM "Camp" WHERE id = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`
      : `SELECT id, name, slug, "websiteUrl", "communitySlug", neighborhood, city, description,
               "campType", category, "registrationStatus", "registrationOpenDate", "lunchIncluded",
               address, "interestingDetails"
         FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != '' ORDER BY "lastVerifiedAt" ASC NULLS FIRST`,
    options.campIds?.length ? [options.campIds] : []
  );

  // Attach empty arrays for relation fields — the diff engine handles missing arrays gracefully
  // (fetching full relations for 158 camps upfront is expensive; we only load them if a diff
  // for that field is detected, which happens in the approve step, not here)
  const camps = campsResult.rows.map(c => ({
    ...c,
    ageGroups: [] as Camp['ageGroups'],
    schedules: [] as Camp['schedules'],
    pricing: [] as Camp['pricing'],
  }));

  // Create crawl run record
  const run = await createCrawlRun({
    triggeredBy: options.triggeredBy,
    trigger: options.trigger ?? 'MANUAL',
    campIds: options.campIds,
    totalCamps: camps.length,
  });

  await emit({ type: 'started', runId: run.id, totalCamps: camps.length });

  let processedCamps = 0;
  let errorCount = 0;
  let newProposals = 0;
  const errorLog: { campId: string; error: string; url: string }[] = [];

  for (let i = 0; i < camps.length; i++) {
    const camp = camps[i];
    await emit({ type: 'camp_processing', campId: camp.id, campName: camp.name, index: i });

    const startMs = Date.now();
    try {
      // Extract
      const result = await extractCampDataFromUrl(camp.websiteUrl, camp.name, { model: options.model });
      const durationMs = Date.now() - startMs;

      if (result.error) {
        errorCount++;
        errorLog.push({ campId: camp.id, error: result.error, url: camp.websiteUrl });
        await appendCrawlError(run.id, { campId: camp.id, error: result.error, url: camp.websiteUrl });
        await appendCrawlLog(run.id, {
          campId: camp.id, campName: camp.name, url: camp.websiteUrl,
          status: 'error', model: result.model ?? 'unknown',
          proposals: 0, fieldsChanged: [], error: result.error,
          durationMs, processedAt: new Date().toISOString(),
        });
        await emit({ type: 'camp_error', campId: camp.id, campName: camp.name, error: result.error });

        // Still record failure metric
        const siteHost = getSiteHost(camp.websiteUrl);
        await recordExtractionMetrics({ runId: run.id, campId: camp.id, siteHost, result, changesFound: 0, durationMs });
      } else {
        // Diff
        const proposedChanges = computeDiff(camp as unknown as import('@/lib/types').Camp, result.extracted, result.confidence, result.excerpts);
        const changesFound = Object.keys(proposedChanges).length;

        let proposalId: string | null = null;
        if (changesFound > 0) {
          const confidence = computeOverallConfidence(proposedChanges);
          let rawExtractionObj: Record<string, unknown> = {};
          try {
            rawExtractionObj = JSON.parse(result.rawResponse || '{}');
          } catch {
            rawExtractionObj = { _raw: result.rawResponse };
          }
          proposalId = await createProposal({
            campId: camp.id,
            crawlRunId: run.id,
            sourceUrl: camp.websiteUrl,
            rawExtraction: rawExtractionObj,
            proposedChanges,
            overallConfidence: confidence,
            extractionModel: result.model,
          });
          newProposals++;
        }

        // Record metrics
        const siteHost = getSiteHost(camp.websiteUrl);
        await recordExtractionMetrics({ runId: run.id, campId: camp.id, siteHost, result, changesFound, durationMs });

        await appendCrawlLog(run.id, {
          campId: camp.id, campName: camp.name, url: camp.websiteUrl,
          status: changesFound > 0 ? 'ok' : 'no_changes',
          model: result.model,
          proposals: changesFound > 0 ? 1 : 0,
          fieldsChanged: Object.keys(proposedChanges),
          durationMs, processedAt: new Date().toISOString(),
        });

        await emit({ type: 'camp_done', campId: camp.id, proposalId, confidence: result.overallConfidence, changesFound });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      errorCount++;
      errorLog.push({ campId: camp.id, error, url: camp.websiteUrl });
      await emit({ type: 'camp_error', campId: camp.id, campName: camp.name, error });
    }

    processedCamps++;
    await updateCrawlRunProgress(run.id, { processedCamps, errorCount, newProposals });

    // Rate limit — be polite
    if (i < camps.length - 1) await delay(2000);
  }

  const finalStatus = errorCount === camps.length && camps.length > 0 ? 'FAILED' : 'COMPLETED';
  await completeCrawlRun(run.id, finalStatus, errorLog);

  const finalRun = { ...run, status: finalStatus as 'COMPLETED' | 'FAILED', processedCamps, errorCount, newProposals };
  await emit({ type: 'completed', runId: run.id, stats: { processedCamps, errorCount, newProposals } });

  return finalRun as CrawlRun;
}

function getSiteHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
