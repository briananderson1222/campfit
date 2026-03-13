#!/usr/bin/env tsx
/**
 * Local crawl runner — thin wrapper over the shared runCrawlPipeline().
 * Bypasses Vercel serverless timeout limits; uses the same code as production.
 *
 * Usage:
 *   npm run crawl                                     # all camps
 *   npm run crawl -- --limit 5                       # first 5 camps (by lastVerifiedAt)
 *   npm run crawl -- --id abc,def                    # specific camp IDs
 *   npm run crawl -- --model gemini:gemini-2.0-flash
 *   npm run crawl -- --provider abc123               # all camps for a provider
 *   npm run crawl -- --url https://example.com       # onboard + crawl a new site
 *   npm run crawl -- --concurrency 5                 # parallel domain concurrency (default 3, max 10)
 *   npm run crawl -- --dry-run                       # fetch + diff only, skip DB writes
 */

import { config } from 'dotenv';
// Load env files in priority order: .env.prod > .env.local > .env (first found wins per var)
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { discoverCampsFromUrl, filterNewDiscoveries } from '@/lib/ingestion/llm-discovery';
import { getPool } from '@/lib/db';
import type { CrawlProgressEvent } from '@/lib/admin/types';

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function parseDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}
function domainToName(domain: string): string {
  const base = domain.split('.')[0];
  return base.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const dryRun  = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit   = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
const idIdx      = args.indexOf('--id');
const campIds    = idIdx !== -1 ? args[idIdx + 1].split(',') : undefined;
const provIdx    = args.indexOf('--provider');
const providerIds = provIdx !== -1 ? args[provIdx + 1].split(',') : undefined;
const modelIdx   = args.indexOf('--model');
const model      = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
const concurrencyIdx = args.indexOf('--concurrency');
const concurrency    = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1], 10) : undefined;
const urlIdx  = args.indexOf('--url');
const onboardUrl = urlIdx !== -1 ? args[urlIdx + 1] : undefined;

if (dryRun) {
  log('DRY RUN mode — LLM + DB writes skipped');
  process.exit(0);
}

// ── Onboard a new URL ────────────────────────────────────────────────────────

async function onboard(url: string) {
  const domain = parseDomain(url);
  if (!domain) { log('ERROR: invalid URL'); process.exit(1); }

  log(`Discovering camps at ${url} ...`);
  const discovery = await discoverCampsFromUrl(url, { model });
  if (!discovery || discovery.error || !discovery.stubs.length) {
    log(`ERROR: ${discovery?.error ?? 'No camps found on that page'}`);
    process.exit(1);
  }
  log(`Found ${discovery.stubs.length} program(s): ${discovery.stubs.map(s => s.name).join(', ')}`);

  const pool = getPool();

  // Find or create Provider
  const { rows: existingProvider } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "Provider" WHERE domain = $1 LIMIT 1`, [domain]
  );
  let providerId: string;
  if (existingProvider.length > 0) {
    providerId = existingProvider[0].id;
    log(`Provider exists: ${existingProvider[0].name} (${providerId})`);
  } else {
    const name = domainToName(domain);
    const base = toSlug(name);
    let slug = base, attempt = 2;
    while (true) {
      const { rows } = await pool.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
      if (rows.length === 0) break;
      slug = `${base}-${attempt++}`;
    }
    const { rows: [created] } = await pool.query<{ id: string }>(
      `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, "crawlRootUrl", "communitySlug")
       VALUES ($1, $2, $3, $4, $5, 'denver')
       ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain RETURNING id`,
      [name, slug, url, domain, url]
    );
    providerId = created.id;
    log(`Created provider: ${name} (${providerId})`);
  }

  // Filter duplicates
  const { rows: existingCamps } = await pool.query<{ name: string }>(
    `SELECT name FROM "Camp" WHERE "websiteUrl" LIKE $1`, [`%${domain}%`]
  );
  const newStubs = filterNewDiscoveries(discovery.stubs, existingCamps.map(r => r.name));
  if (newStubs.length === 0) { log('All discovered programs already exist — nothing to add.'); process.exit(0); }
  log(`${newStubs.length} new program(s) after dedup`);

  // Insert stubs
  const newCampIds: string[] = [];
  for (const stub of newStubs) {
    const campUrl = stub.detailUrl ?? url;
    const campSlug = toSlug(stub.name) + '-' + Math.random().toString(36).slice(2, 6);
    const { rows: [camp] } = await pool.query<{ id: string }>(
      `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
       VALUES ($1, $2, $3, 'denver', 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $4)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [stub.name, campSlug, campUrl, providerId]
    );
    if (camp) { newCampIds.push(camp.id); log(`  + ${stub.name}`); }
  }

  if (newCampIds.length === 0) { log('ERROR: failed to insert any camps'); process.exit(1); }
  log(`Inserted ${newCampIds.length} stub(s) — starting crawl...`);

  return newCampIds;
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  let resolvedCampIds = campIds;

  if (onboardUrl) {
    resolvedCampIds = await onboard(onboardUrl);
  } else {
    log(`Starting crawl — limit=${limit ?? 'all'} ids=${campIds?.join(',') ?? 'all'} providers=${providerIds?.join(',') ?? 'none'} model=${model ?? 'auto'} concurrency=${concurrency ?? 3}`);
  }

  const onProgress = async (event: CrawlProgressEvent) => {
    switch (event.type) {
      case 'started':
        log(`Run ${event.runId} started — ${event.totalCamps} camps`);
        break;
      case 'camp_processing':
        log(`[${event.index + 1}] ${event.campName}`);
        break;
      case 'camp_done':
        log(`  → done — ${event.changesFound} changes (conf ${event.confidence?.toFixed(2) ?? '?'})${event.proposalId ? ` — proposal ${event.proposalId}` : ''}`);
        break;
      case 'camp_error':
        log(`  → ERROR: ${event.error}`);
        break;
      case 'completed':
        log(`Completed — processed=${event.stats.processedCamps} errors=${event.stats.errorCount} proposals=${event.stats.newProposals}`);
        break;
    }
  };

  const run = await runCrawlPipeline({
    triggeredBy: 'cli',
    trigger: 'MANUAL',
    campIds: resolvedCampIds,
    providerIds,
    limit,
    model,
    concurrency,
    onProgress,
  });

  log(`Run ${run.id} — status: ${run.status}`);
  process.exit(run.status === 'FAILED' ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
