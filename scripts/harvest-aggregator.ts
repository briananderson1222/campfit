#!/usr/bin/env tsx
/**
 * Aggregator harvester — seeds new Camp stubs from third-party directories,
 * then optionally runs the standard crawl pipeline to enrich them.
 *
 * Usage:
 *   npm run harvest -- --source activitieskids
 *   npm run harvest -- --source activitieskids --limit 50 --dry-run
 *   npm run harvest -- --source activitieskids --crawl-after  # seed + crawl new camps
 *   npm run harvest -- --source activitieskids --community denver
 */

import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { ActivitiesKidsHarvester } from '@/lib/ingestion/aggregator/activitieskids';
import type { BaseHarvester } from '@/lib/ingestion/aggregator/base-harvester';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const sourceIdx = args.indexOf('--source');
const source    = sourceIdx !== -1 ? args[sourceIdx + 1] : null;
const limitIdx  = args.indexOf('--limit');
const limit     = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;
const commIdx   = args.indexOf('--community');
const community = commIdx !== -1 ? args[commIdx + 1] : 'denver';
const dryRun    = args.includes('--dry-run');
const crawlAfter = args.includes('--crawl-after');
const modelIdx  = args.indexOf('--model');
const model     = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

if (!source) {
  console.error('Usage: npm run harvest -- --source <activitieskids|...> [--limit N] [--dry-run] [--crawl-after]');
  console.error('Available sources: activitieskids');
  process.exit(1);
}

// ── Source registry ──────────────────────────────────────────────────────────

const HARVESTERS: Record<string, () => BaseHarvester> = {
  activitieskids: () => new ActivitiesKidsHarvester(),
  // Add more harvesters here:
  // summercamphub: () => new SummerCampHubHarvester(),
  // kidsindenver: () => new KidsInDenverHarvester(),
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const factory = HARVESTERS[source!];
  if (!factory) {
    console.error(`Unknown source: "${source}". Available: ${Object.keys(HARVESTERS).join(', ')}`);
    process.exit(1);
  }

  const harvester = factory();
  const result = await harvester.harvest({
    limit,
    dryRun,
    communitySlug: community,
    onProgress: log,
  });

  log(`\nHarvest summary:`);
  log(`  Discovered: ${result.discovered}`);
  log(`  Created:    ${result.created} new camp stubs`);
  log(`  Skipped:    ${result.skipped} (already in DB)`);
  log(`  Flagged:    ${result.flagged} (possible duplicates — review manually)`);

  if (result.campIds.length > 0 && crawlAfter && !dryRun) {
    log(`\nStarting crawl of ${result.campIds.length} new camps…`);
    const run = await runCrawlPipeline({
      triggeredBy: 'harvest-cli',
      trigger: 'MANUAL',
      campIds: result.campIds,
      model,
      concurrency: 3,
      onProgress: async event => {
        if (event.type === 'camp_processing') log(`  [crawl] ${event.campName}`);
        if (event.type === 'camp_done') log(`  [crawl] → ${event.changesFound} changes`);
        if (event.type === 'camp_error') log(`  [crawl] ERROR: ${event.error}`);
        if (event.type === 'completed') log(`  [crawl] done — ${event.stats.newProposals} proposals created`);
      },
    });
    log(`Crawl run ${run.id} completed — status: ${run.status}`);
  } else if (result.campIds.length > 0 && !dryRun) {
    log(`\nNew camps ready to crawl. Run:`);
    log(`  npm run crawl -- --id ${result.campIds.slice(0, 5).join(',')}${result.campIds.length > 5 ? ',…' : ''}`);
    log(`Or re-run harvest with --crawl-after to enrich automatically.`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
