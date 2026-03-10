#!/usr/bin/env tsx
/**
 * Local crawl runner — thin wrapper over the shared runCrawlPipeline().
 * Bypasses Vercel serverless timeout limits; uses the same code as production.
 *
 * Usage:
 *   npm run crawl                           # all camps
 *   npm run crawl -- --limit 5             # first 5 camps (by lastVerifiedAt)
 *   npm run crawl -- --id abc,def          # specific camp IDs
 *   npm run crawl -- --model gemini:gemini-2.0-flash
 *   npm run crawl -- --provider abc123     # all camps for a provider
 *   npm run crawl -- --concurrency 5       # parallel domain concurrency (default 3, max 10)
 *   npm run crawl -- --dry-run             # fetch + diff only, skip DB writes
 */

import { config } from 'dotenv';
// Load env files in priority order: .env.prod > .env.local > .env (first found wins per var)
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import type { CrawlProgressEvent } from '@/lib/admin/types';

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

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

if (dryRun) {
  log('DRY RUN mode — LLM + DB writes skipped');
  process.exit(0);
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting crawl — limit=${limit ?? 'all'} ids=${campIds?.join(',') ?? 'all'} providers=${providerIds?.join(',') ?? 'none'} model=${model ?? 'auto'} concurrency=${concurrency ?? 3}`);

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
    campIds,
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
