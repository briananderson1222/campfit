import { getPool } from '@/lib/db';
import { extractCampDataFromUrl } from './llm-extractor';
import { computeDiff, computeOverallConfidence } from './diff-engine';
import { createCrawlRun, updateCrawlRunProgress, completeCrawlRun, appendCrawlError, appendCrawlLog } from '@/lib/admin/crawl-repository';
import { createProposal } from '@/lib/admin/review-repository';
import { recordExtractionMetrics } from '@/lib/admin/metrics-repository';
import { discoverCampsFromUrl, filterNewDiscoveries } from './llm-discovery';
import type { CrawlProgressEvent, CrawlRun } from '@/lib/admin/types';
import type { Camp } from '@/lib/types';

// ── Provider matching helpers ──────────────────────────────────────────────────

function parseDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function domainToName(domain: string): string {
  const base = domain.split('.')[0];
  return base
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function makeUniqueSlug(pool: import('pg').Pool, name: string): Promise<string> {
  const base = toSlug(name);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}

/**
 * For a successfully-crawled camp, ensure it's linked to a Provider.
 * Matches by domain first; creates a new Provider if none exists.
 * No-ops if the camp already has a providerId.
 * Returns a short status string for logging.
 */
async function matchOrCreateProvider(
  pool: import('pg').Pool,
  camp: { id: string; websiteUrl: string; communitySlug: string; city: string | null; providerId: string | null; organizationName?: string | null }
): Promise<string | null> {
  if (camp.providerId) return null; // already linked

  const domain = parseDomain(camp.websiteUrl);
  if (!domain) return null;

  // Find existing provider by domain
  const { rows: existing } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "Provider" WHERE domain = $1 LIMIT 1`,
    [domain]
  );

  let providerId: string;
  let action: string;

  if (existing.length > 0) {
    providerId = existing[0].id;
    action = `matched → ${existing[0].name}`;
  } else {
    const name = camp.organizationName?.trim() || domainToName(domain);
    const slug = await makeUniqueSlug(pool, name);
    const { rows: [created] } = await pool.query<{ id: string }>(
      `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, city, "communitySlug")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain, "updatedAt" = now()
       RETURNING id`,
      [name, slug, camp.websiteUrl, domain, camp.city, camp.communitySlug]
    );
    providerId = created.id;
    action = `created → ${name}`;
  }

  await pool.query(
    `UPDATE "Camp" SET "providerId" = $1 WHERE id = $2 AND "providerId" IS NULL`,
    [providerId, camp.id]
  );

  return action;
}

// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  private slots: number;
  private queue: (() => void)[] = [];
  constructor(concurrency: number) { this.slots = concurrency; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      if (this.slots > 0) { this.slots--; resolve(); }
      else this.queue.push(resolve);
    });
    try { return await fn(); }
    finally {
      if (this.queue.length > 0) this.queue.shift()!();
      else this.slots++;
    }
  }
}

export interface CrawlOptions {
  triggeredBy: string;
  trigger?: 'MANUAL' | 'SCHEDULED';
  campIds?: string[];
  providerIds?: string[];  // crawl all camps for these providers
  limit?: number;
  model?: string;
  concurrency?: number;  // max simultaneous domains being crawled (default 3)
  discover?: boolean;    // run discovery pre-pass on listing pages
  onProgress?: (event: CrawlProgressEvent) => void | Promise<void>;
}

export async function runCrawlPipeline(options: CrawlOptions): Promise<CrawlRun> {
  const pool = getPool();
  const emit = options.onProgress ?? (() => {});

  // Resolve campIds from providerIds if provided
  let resolvedCampIds = options.campIds;
  if (!resolvedCampIds?.length && options.providerIds?.length) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "Camp" WHERE "providerId" = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`,
      [options.providerIds]
    );
    resolvedCampIds = rows.map(r => r.id);
  }

  // Fetch camps to crawl (scalar fields only — array relations are fetched separately per camp)
  const campsResult = await pool.query<Camp & { id: string; name: string; websiteUrl: string; communitySlug: string; fieldSources: Record<string, { approvedAt?: string }> }>(
    resolvedCampIds?.length
      ? `SELECT id, name, slug, "websiteUrl", "communitySlug", neighborhood, city, description,
               "campType", category, "campTypes", "categories", state, zip,
               "registrationStatus", "registrationOpenDate", "lunchIncluded",
               address, "interestingDetails", "providerId", "organizationName",
               COALESCE("fieldSources", '{}') AS "fieldSources"
         FROM "Camp" WHERE id = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`
      : `SELECT id, name, slug, "websiteUrl", "communitySlug", neighborhood, city, description,
               "campType", category, "campTypes", "categories", state, zip,
               "registrationStatus", "registrationOpenDate", "lunchIncluded",
               address, "interestingDetails", "providerId", "organizationName",
               COALESCE("fieldSources", '{}') AS "fieldSources"
         FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != '' ORDER BY "lastVerifiedAt" ASC NULLS FIRST${options.limit ? ` LIMIT ${options.limit}` : ''}`,
    resolvedCampIds?.length ? [resolvedCampIds] : []
  );

  // Fetch neighborhoods once for the run (community slug from first camp or default 'denver')
  const communitySlug = campsResult.rows[0]?.communitySlug ?? 'denver';
  const neighborhoodsResult = await pool.query<{ name: string }>(
    `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1 ORDER BY name ASC`,
    [communitySlug]
  );
  const neighborhoods = neighborhoodsResult.rows.map(r => r.name);

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

  // Group camps by domain for politeness (same domain → sequential)
  const domainMap = new Map<string, typeof camps>();
  for (const camp of camps) {
    const host = getSiteHost(camp.websiteUrl);
    if (!domainMap.has(host)) domainMap.set(host, []);
    domainMap.get(host)!.push(camp);
  }

  const concurrency = Math.min(options.concurrency ?? 3, 10);
  const semaphore = new Semaphore(concurrency);

  let globalIndex = 0;

  const domainTasks = Array.from(domainMap.values()).map(domainCamps =>
    semaphore.run(async () => {
      // ── Discovery pre-pass ──────────────────────────────────────────────────
      // When 2+ camps share the same URL it's likely a listing page.
      // Run discovery to find new programs and inject them into domainCamps.
      if (options.discover === true && domainCamps.length >= 2) {
        const listingUrl = domainCamps[0].websiteUrl;
        const sharedUrl = domainCamps.every(c => c.websiteUrl === listingUrl);
        if (sharedUrl) {
          const existingNames = domainCamps.map(c => c.name);
          const discovery = await discoverCampsFromUrl(listingUrl, { model: options.model }).catch(err => {
            console.error(`[crawl] discovery failed for ${listingUrl}:`, err);
            return null;
          });
          if (discovery && !discovery.error && discovery.isListingPage && discovery.stubs.length > 0) {
            const newStubs = filterNewDiscoveries(discovery.stubs, existingNames);
            if (newStubs.length > 0) {
              console.log(`[crawl] discovery found ${newStubs.length} new programs at ${listingUrl}`);
              // Resolve community/provider info from first camp in group
              const refCamp = domainCamps[0] as unknown as { communitySlug: string; city: string | null; providerId: string | null };
              for (const stub of newStubs) {
                try {
                  const campUrl = stub.detailUrl ?? listingUrl;
                  const campSlug = toSlug(stub.name) + '-' + Math.random().toString(36).slice(2, 6);
                  const { rows: [newCamp] } = await pool.query<{ id: string; name: string; websiteUrl: string; communitySlug: string; city: string | null; fieldSources: Record<string, unknown> }>(
                    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", city, "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
                     VALUES ($1, $2, $3, $4, $5, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $6)
                     ON CONFLICT (slug) DO NOTHING
                     RETURNING id, name, "websiteUrl", "communitySlug", city, COALESCE("fieldSources", '{}') AS "fieldSources"`,
                    [stub.name, campSlug, campUrl, refCamp.communitySlug, refCamp.city, refCamp.providerId]
                  );
                  if (newCamp) {
                    console.log(`[crawl] created discovered camp: ${newCamp.name} (${newCamp.id})`);
                    domainCamps.push({
                      ...newCamp,
                      slug: campSlug,
                      neighborhood: null, description: null, campType: null, category: null,
                      registrationStatus: null, registrationOpenDate: null, lunchIncluded: null,
                      address: null, interestingDetails: null, providerId: refCamp.providerId,
                      ageGroups: [] as Camp['ageGroups'],
                      schedules: [] as Camp['schedules'],
                      pricing: [] as Camp['pricing'],
                    } as unknown as typeof camps[0]);
                  }
                } catch (err) {
                  console.error(`[crawl] failed to insert discovered camp "${stub.name}":`, err);
                }
              }
            }
          }
        }
      }

      for (let di = 0; di < domainCamps.length; di++) {
        const camp = domainCamps[di];
        const campIndex = globalIndex++;
        await emit({ type: 'camp_processing', campId: camp.id, campName: camp.name, index: campIndex });

        const startMs = Date.now();
        try {
          // Fetch site hints for this domain
          const domain = getSiteHost(camp.websiteUrl).replace(/^www\./, '');
          const hintsResult = await pool.query<{ hint: string }>(
            `SELECT hint FROM "CrawlSiteHint" WHERE domain = $1 AND active = true ORDER BY "createdAt" ASC`,
            [domain]
          );
          const siteHints = hintsResult.rows.map(r => r.hint);

          // Extract
          const result = await extractCampDataFromUrl(camp.websiteUrl, camp.name, {
            model: options.model,
            siteHints,
            neighborhoods,
          });
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
            // Diff (with fieldSources for suppression of recently-approved fields)
            const fieldSources = (camp as unknown as { fieldSources: Record<string, { approvedAt?: string }> }).fieldSources ?? {};
            const proposedChanges = computeDiff(
              camp as unknown as import('@/lib/types').Camp,
              result.extracted,
              result.confidence,
              result.excerpts,
              fieldSources,
              camp.websiteUrl
            );
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

            // Provider matching — ensure camp is linked to a Provider by domain
            const providerAction = await matchOrCreateProvider(pool, {
              id: camp.id,
              websiteUrl: camp.websiteUrl,
              communitySlug: camp.communitySlug,
              city: camp.city ?? null,
              providerId: (camp as unknown as { providerId: string | null }).providerId ?? null,
              organizationName: (camp as any).organizationName ?? null,
            }).catch(err => {
              console.error(`[crawl] provider match failed for camp ${camp.id}:`, err);
              return null;
            });

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
              ...(providerAction ? { providerAction } : {}),
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
        // Fire-and-forget progress update — order doesn't matter in parallel mode
        void updateCrawlRunProgress(run.id, { processedCamps, errorCount, newProposals });

        // Rate limit — be polite to each domain
        if (di < domainCamps.length - 1) await delay(2000);
      }
    })
  );

  await Promise.all(domainTasks);

  // If discovery added new camps, processedCamps > original totalCamps — fix the DB record
  if (processedCamps > camps.length) {
    await updateCrawlRunProgress(run.id, { totalCamps: processedCamps });
  }

  const finalStatus = errorCount === processedCamps && processedCamps > 0 ? 'FAILED' : 'COMPLETED';
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
