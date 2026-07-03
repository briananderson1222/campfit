/**
 * cutover-baseline.ts — the BEFORE baseline for the traverse full cutover
 * (owner directive, 2026-07), captured while the legacy CSS-selector
 * scrapers still exist.
 *
 * For each in-scope source (avid4, denver-art-museum, idtech) this:
 *  1. Fetches the entry page LIVE via `@kontourai/traverse/fetch`'s
 *     `fetchSource` in capture mode, persisting the snapshot to the shared
 *     CampFit snapshot store (`.kontourai/campfit/snapshots/`) — the same
 *     store the traverse pilot/parity harness already writes to. This is
 *     "live-with-capture" for the fetch side: a real network fetch whose
 *     bytes are captured for byte-identical replay.
 *  2. Runs the LEGACY scraper's `scrape()` against a cheerio context built
 *     from THOSE EXACT captured bytes (not a second independent fetch), so
 *     the recorded camp count / field coverage is provably what legacy
 *     produced from the snapshot this baseline references — the comparison
 *     is replayable without a second live fetch.
 *  3. Computes camp count + a field-coverage map (which CampInput fields are
 *     non-null/non-empty across the extracted camps).
 *
 * Output: tests/fixtures/cutover-baseline-2026-07.json (committed) — counts
 * + coverage + snapshot identity (bodyHash/fetchedAt/status) only; the actual
 * snapshot bytes stay in the gitignored `.kontourai/` store, referenced here
 * by hash so a later run can `replaySource(store, sourceKey)` and get back
 * the exact page this baseline was measured against.
 *
 * This is the "proper tests before" step of the owner's cutover directive:
 * run once, while legacy still exists, before any deletion happens.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import { fetchSource } from "@kontourai/traverse/fetch";
import { Avid4Scraper } from "../lib/ingestion/scrapers/avid4";
import { DenverArtMuseumScraper } from "../lib/ingestion/scrapers/denver-arts";
import { IdTechScraper } from "../lib/ingestion/scrapers/idtech";
import { BaseScraper, ScrapeContext } from "../lib/ingestion/scraper-base";
import { CampInput } from "../lib/ingestion/adapter";
import {
  createCampfitSnapshotStore,
  CAMPFIT_FETCH_USER_AGENT,
} from "../lib/ingestion/traverse-snapshot-store";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const OUT_PATH = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "cutover-baseline-2026-07.json"
);

/** CampInput scalar/collection fields the coverage map reports on. */
const COVERAGE_FIELDS = [
  "name",
  "description",
  "category",
  "registrationStatus",
  "applicationUrl",
  "websiteUrl",
  "city",
  "neighborhood",
  "address",
  "ageGroups",
  "schedules",
  "pricing",
] as const;

function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Fraction (0..1) of `camps` where `field` is non-null/non-empty, plus the raw count. */
function fieldCoverage(camps: CampInput[], field: (typeof COVERAGE_FIELDS)[number]) {
  const count = camps.filter((c) => isNonEmpty((c as unknown as Record<string, unknown>)[field])).length;
  return { count, fraction: camps.length > 0 ? Math.round((count / camps.length) * 100) / 100 : 0 };
}

interface BaselineSource {
  key: string;
  url: string;
  scraperName: string;
  campCount: number;
  legacyErrors: string[];
  fieldCoverage: Record<string, { count: number; fraction: number }>;
  snapshot: {
    bodyHash: string;
    status: number;
    fetchedAt: string;
    finalUrl: string;
    bodyChars: number;
  } | null;
  fetchError: string | null;
}

/** Runs a legacy scraper's scrape() against pre-fetched HTML (no second fetch). */
class ReplayableScraper extends BaseScraper {
  readonly scraperName: string;
  readonly sourceKey: string;
  readonly entryUrl: string;
  constructor(
    private readonly inner: BaseScraper,
    private readonly html: string
  ) {
    super();
    this.scraperName = inner.scraperName;
    this.sourceKey = inner.sourceKey;
    this.entryUrl = inner.entryUrl;
  }
  protected async fetchPage(url: string): Promise<ScrapeContext> {
    return { $: cheerio.load(this.html), html: this.html, url };
  }
  async scrape(ctx: ScrapeContext): Promise<CampInput[]> {
    // Delegate to the real scraper's extraction logic via a same-shape context.
    return this.inner.scrape(ctx);
  }
}

const SOURCES: BaseScraper[] = [
  new Avid4Scraper(),
  new DenverArtMuseumScraper(),
  new IdTechScraper(),
];

async function captureSource(scraper: BaseScraper): Promise<BaselineSource> {
  const store = createCampfitSnapshotStore();
  console.log(`\n=== ${scraper.sourceKey} (${scraper.entryUrl}) ===`);

  const fetchResult = await fetchSource({
    id: scraper.sourceKey,
    url: scraper.entryUrl,
    contentType: "html",
    userAgent: CAMPFIT_FETCH_USER_AGENT,
  });

  if (fetchResult.error || !fetchResult.snapshot) {
    const msg = fetchResult.error
      ? `${fetchResult.error.kind}: ${fetchResult.error.message}`
      : "no snapshot";
    console.error(`  ✗ fetch failed: ${msg}`);
    return {
      key: scraper.sourceKey,
      url: scraper.entryUrl,
      scraperName: scraper.scraperName,
      campCount: 0,
      legacyErrors: [`fetch failed: ${msg}`],
      fieldCoverage: Object.fromEntries(COVERAGE_FIELDS.map((f) => [f, { count: 0, fraction: 0 }])),
      snapshot: null,
      fetchError: msg,
    };
  }

  const snapshot = fetchResult.snapshot;
  await store.put(snapshot);
  console.log(`  ✓ fetched + captured: status ${snapshot.status}, ${snapshot.body.length} bytes, hash ${snapshot.bodyHash.slice(0, 12)}`);

  const replayable = new ReplayableScraper(scraper, snapshot.body);
  const { camps, errors } = await replayable.run();
  console.log(`  legacy scraper: ${camps.length} camps${errors.length ? ` (errors: ${errors.join("; ")})` : ""}`);

  const coverage = Object.fromEntries(
    COVERAGE_FIELDS.map((f) => [f, fieldCoverage(camps, f)])
  );

  return {
    key: scraper.sourceKey,
    url: scraper.entryUrl,
    scraperName: scraper.scraperName,
    campCount: camps.length,
    legacyErrors: errors,
    fieldCoverage: coverage,
    snapshot: {
      bodyHash: snapshot.bodyHash,
      status: snapshot.status,
      fetchedAt: snapshot.fetchedAt,
      finalUrl: snapshot.url,
      bodyChars: snapshot.body.length,
    },
    fetchError: null,
  };
}

async function main() {
  const results: BaselineSource[] = [];
  for (const scraper of SOURCES) {
    results.push(await captureSource(scraper));
  }

  const baseline = {
    generatedAt: new Date().toISOString(),
    note:
      "BEFORE baseline for the traverse full cutover (owner directive, 2026-07). " +
      "Captured live, while the legacy CSS-selector scrapers still existed. " +
      "Snapshot bytes are NOT stored here (gitignored .kontourai/campfit/snapshots/); " +
      "this file references them by sourceId + bodyHash so a later run can " +
      "replaySource(store, sourceId) to reproduce the exact page these counts came from.",
    sources: Object.fromEntries(results.map((r) => [r.key, r])),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\n✓ Baseline written to ${path.relative(process.cwd(), OUT_PATH)}`);
  for (const r of results) {
    console.log(`  • ${r.key}: ${r.campCount} camps`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
