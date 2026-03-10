/**
 * Base class for aggregator harvesters.
 *
 * An aggregator harvester scrapes a third-party camp directory (e.g.
 * ActivitiesForKids.com) to discover camps not yet in our system, then
 * creates stub Camp records that feed into the standard crawl pipeline.
 *
 * The harvester ONLY creates stubs. Enrichment (description, pricing,
 * schedules, age groups, etc.) happens via the existing runCrawlPipeline()
 * call — fully DRY with the production crawl path.
 */

import type { CampCategory, CampType } from '@/lib/types';
import { getPool } from '@/lib/db';
import { stripHtmlToText } from '@/lib/ingestion/html-stripper';

export interface HarvestedListing {
  name: string;
  websiteUrl: string;
  description?: string | null;
  city?: string | null;
  communitySlug?: string;
  category?: CampCategory | null;
  campType?: CampType | null;
  organizationName?: string | null;
  sourceUrl: string; // the aggregator URL this listing was found on
}

export interface HarvestResult {
  discovered: number;  // total listings found on aggregator
  created: number;     // new Camp stubs inserted
  skipped: number;     // already in DB (exact websiteUrl match)
  flagged: number;     // possible duplicates (name similarity, different URL)
  campIds: string[];   // IDs of newly created camps (ready to crawl)
}

export interface HarvestOptions {
  limit?: number;
  dryRun?: boolean;
  communitySlug?: string;
  onProgress?: (msg: string) => void;
}

// ── Similarity helper (Dice coefficient on bigrams) ───────────────────────────

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  const norm = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2));
  return set;
}

export function nameSimilarity(a: string, b: string): number {
  const ba = bigrams(a), bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  ba.forEach(g => { if (bb.has(g)) intersection++; });
  return (2 * intersection) / (ba.size + bb.size);
}

// ── Base harvester ────────────────────────────────────────────────────────────

export abstract class BaseHarvester {
  readonly sourceName: string;

  constructor(sourceName: string) {
    this.sourceName = sourceName;
  }

  /**
   * Subclasses implement this to return all listings from the aggregator.
   * May paginate internally.
   */
  abstract fetchListings(communitySlug: string, limit?: number): Promise<HarvestedListing[]>;

  /** Fetch HTML from a URL with a browser-like User-Agent. */
  protected async fetchHtml(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }

  /** Strip HTML to plain text for further parsing. */
  protected stripHtml(html: string, maxChars = 50_000): string {
    return stripHtmlToText(html, maxChars);
  }

  /**
   * Match a listing against the existing Camp table and create a stub if new.
   * Returns { action: 'created' | 'skipped' | 'flagged', campId? }.
   */
  async matchOrCreate(
    listing: HarvestedListing,
    options: { dryRun?: boolean } = {}
  ): Promise<{ action: 'created' | 'skipped' | 'flagged'; campId?: string; reason?: string }> {
    const pool = getPool();

    // 1. Exact websiteUrl match → already have this camp
    if (listing.websiteUrl) {
      const { rows } = await pool.query(
        `SELECT id FROM "Camp" WHERE "websiteUrl" = $1 LIMIT 1`,
        [listing.websiteUrl]
      );
      if (rows.length > 0) return { action: 'skipped', campId: rows[0].id, reason: 'exact URL match' };
    }

    // 2. Name similarity check against existing camps (Dice > 0.75 = possible duplicate)
    const { rows: nameCandidates } = await pool.query<{ id: string; name: string; websiteUrl: string }>(
      `SELECT id, name, "websiteUrl" FROM "Camp"
       WHERE "communitySlug" = $1
       ORDER BY similarity(name, $2) DESC LIMIT 5`,
      [listing.communitySlug ?? 'denver', listing.name]
    ).catch(() => ({ rows: [] as { id: string; name: string; websiteUrl: string }[] }));

    for (const candidate of nameCandidates) {
      if (nameSimilarity(listing.name, candidate.name) > 0.75) {
        return {
          action: 'flagged',
          campId: candidate.id,
          reason: `name similar to existing: "${candidate.name}"`,
        };
      }
    }

    // 3. Create new stub Camp
    if (options.dryRun) return { action: 'created' };

    const slug = await makeUniqueSlug(pool, listing.name);
    const { rows: [camp] } = await pool.query<{ id: string }>(
      `INSERT INTO "Camp"
         (slug, name, description, "websiteUrl", "campType", category, city,
          "communitySlug", "organizationName", "sourceType", "dataConfidence",
          "sourceUrl", "registrationStatus")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SCRAPER','PLACEHOLDER',$10,'UNKNOWN')
       RETURNING id`,
      [
        slug, listing.name,
        listing.description ?? '',
        listing.websiteUrl ?? null,
        listing.campType ?? 'SUMMER_DAY',
        listing.category ?? 'OTHER',
        listing.city ?? 'Denver',
        listing.communitySlug ?? 'denver',
        listing.organizationName ?? null,
        listing.sourceUrl,
      ]
    );
    return { action: 'created', campId: camp.id };
  }

  /** Run the full harvest: fetch listings, match/create, return summary. */
  async harvest(options: HarvestOptions = {}): Promise<HarvestResult> {
    const { limit, dryRun = false, communitySlug = 'denver', onProgress } = options;
    const log = onProgress ?? ((msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`));

    log(`Starting harvest from ${this.sourceName} (community=${communitySlug} limit=${limit ?? 'all'} dryRun=${dryRun})`);
    const listings = await this.fetchListings(communitySlug, limit);
    log(`Found ${listings.length} listings`);

    const result: HarvestResult = { discovered: listings.length, created: 0, skipped: 0, flagged: 0, campIds: [] };

    for (const listing of listings) {
      const { action, campId, reason } = await this.matchOrCreate(listing, { dryRun });
      if (action === 'created') {
        result.created++;
        if (campId) result.campIds.push(campId);
        log(`  + created: ${listing.name} (${listing.websiteUrl})`);
      } else if (action === 'skipped') {
        result.skipped++;
        log(`  ~ skipped: ${listing.name} — ${reason}`);
      } else {
        result.flagged++;
        log(`  ? flagged: ${listing.name} — ${reason}`);
      }
    }

    log(`Done — created=${result.created} skipped=${result.skipped} flagged=${result.flagged}`);
    return result;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeUniqueSlug(pool: ReturnType<typeof getPool>, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM "Camp" WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}
