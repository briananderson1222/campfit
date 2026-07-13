#!/usr/bin/env tsx
/**
 * Crawl aggregator-discovered PROVIDERS as multi-item listing sources.
 *
 * An aggregator harvester (e.g. Camperoni) surfaces provider organizations,
 * each of which typically runs MANY programs on its own site — so a provider
 * page is a mini-listing, not a single camp. This CLI runs each discovered
 * provider URL through the crawl pipeline's SOURCES strategy
 * (`runCrawlPipeline({ sources, ... })`, multi-item extraction) rather than
 * the single-camp recrawl strategy (`--crawl-after` in harvest-aggregator.ts),
 * which correctly refuses to guess which of N listed programs a provider
 * "is". Each provider yields multiple CampChangeProposals for human review.
 *
 * Fetch strategy: plain HTTP GET first, with an automatic render fallback —
 * traverse's shell-detection auto-retry (campfit#53) renders via headless
 * Chromium (`createCampfitRenderImpl`) only when a plain fetch comes back
 * looking like an empty JS shell. Cheap for plain-HTML providers, correct for
 * SPA providers, no per-site config. Requires a browser-capable execution
 * context (this CLI / GitHub Actions), never Vercel.
 *
 * Usage:
 *   npm run crawl:providers -- --source camperoni
 *   npm run crawl:providers -- --source camperoni --limit 5
 *   npm run crawl:providers -- --source camperoni --dry-run   # list providers, do not crawl
 *   npm run crawl:providers -- --source camperoni --community denver
 */
import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { getHarvester, knownSources } from '@/lib/ingestion/aggregator/harvester-registry';
import type { IngestionSourceConfig } from '@/lib/ingestion/sources';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { closeRenderBrowser, tryCreateCampfitRenderImpl } from '@/lib/ingestion/render-fetch';
import { getPool } from '@/lib/db';

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const source = flag('--source');
const limitRaw = flag('--limit');
const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
const community = flag('--community') ?? 'denver';
const dryRun = args.includes('--dry-run');

if (!source) {
  console.error(`Usage: npm run crawl:providers -- --source <${knownSources()}> [--limit N] [--dry-run] [--community denver]`);
  process.exit(1);
}

/** Stable, filesystem-safe source key for snapshot-store identity + reporting. */
function sourceKey(sourceName: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  return `agg:${sourceName}:${slug}`;
}

async function main() {
  const harvester = getHarvester(source!);
  if (!harvester) {
    console.error(`Unknown source: "${source}". Available: ${knownSources()}`);
    process.exit(1);
  }

  log(`Discovering providers from ${source} (community=${community} limit=${limit ?? 'all'})…`);
  const listings = await harvester.fetchListings(community, limit);
  const sources: IngestionSourceConfig[] = listings.map((l) => ({
    key: sourceKey(source!, l.name),
    name: l.name,
    url: l.websiteUrl,
  }));
  log(`Found ${sources.length} provider source(s).`);

  if (dryRun) {
    for (const s of sources) log(`  would crawl: ${s.name} — ${s.url}`);
    log('Dry run: no crawl performed (the sources strategy always writes a real CrawlRun, so it is intentionally not run under --dry-run).');
    process.exit(0);
  }

  if (sources.length === 0) {
    log('No providers to crawl.');
    process.exit(0);
  }

  const renderImpl = tryCreateCampfitRenderImpl();
  if (renderImpl) {
    log('Render fallback: available (SPA provider pages will render on shell detection).');
  } else {
    log('Render fallback: UNAVAILABLE in this context (no safe browser egress) — plain fetch only. SPA-only provider pages will yield 0 items until safe browser egress lands.');
  }

  const pool = getPool();
  const before = (await pool.query('SELECT count(*)::int n FROM "CampChangeProposal"')).rows[0].n;

  try {
    const run = await runCrawlPipeline({
      sources,
      triggeredBy: 'crawl-aggregator-providers',
      trigger: 'MANUAL',
      // Fresh discovery: treat every extracted item as new (surface all to review).
      currentByItemNames: async () => new Map(),
      onSourceResult: (result: unknown) => {
        const r = result as { source?: string; itemCount?: number; routedProposalIds?: (string | null)[]; ok?: boolean };
        const proposals = (r.routedProposalIds ?? []).filter(Boolean).length;
        log(`  [provider] ${r.source ?? '?'}: ${r.ok === false ? 'FAILED' : `${r.itemCount ?? 0} item(s) → ${proposals} proposal(s)`}`);
      },
      // Plain fetch first; shell-detection auto-retries with render via this
      // headless-Chromium impl only when a provider page looks like a JS shell
      // AND safe browser egress is available (else undefined = plain-only).
      fetchOptions: renderImpl ? { renderImpl } : undefined,
    });

    const after = (await pool.query('SELECT count(*)::int n FROM "CampChangeProposal"')).rows[0].n;
    log(`Crawl run ${run.id} — status: ${run.status}`);
    log(`Proposals created: ${after - before} (now pending review)`);
  } finally {
    await closeRenderBrowser();
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
