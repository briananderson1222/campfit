/**
 * test-scrape-error-handling.ts — verifies per-source scrape failures are
 * non-fatal (regression test for the 2026-06-15+ weekly scrape.yml failures
 * caused by a dead Denver Art Museum URL taking down the whole sweep).
 *
 * Covers:
 *  - BaseScraper.run() never throws — HTTP/network errors become
 *    { camps: [], errors: [message] } instead of propagating.
 *  - runScraperSafe() isolates a source-level failure into a report entry
 *    (ok: false) without throwing, and a healthy source AFTER a dead one
 *    in the list still runs (mid-list continuation).
 *  - summarizeReport() threshold behavior: a single dead source among a
 *    small registry (1 of 2, exactly 50%) does NOT trip the default
 *    >50% threshold; but zero successes, or a majority failing, does.
 *  - resolveFailureThreshold() env var parsing + fallback on bad input.
 */

import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { BaseScraper, ScrapeContext } from "../lib/ingestion/scraper-base";
import { CampInput } from "../lib/ingestion/adapter";
import {
  runScraperSafe,
  summarizeReport,
  resolveFailureThreshold,
  DEFAULT_FAILURE_THRESHOLD_RATIO,
  ScraperReportEntry,
} from "../lib/ingestion/scrape-runner";

// ─── Test fixtures ──────────────────────────────────────────────────────

function minimalCamp(name: string): CampInput {
  return {
    slug: name,
    name,
    description: "",
    notes: null,
    campType: "SUMMER_DAY",
    category: "ARTS",
    websiteUrl: "https://example.test/camp",
    interestingDetails: null,
    city: "Denver",
    region: null,
    neighborhood: "",
    address: "",
    latitude: null,
    longitude: null,
    lunchIncluded: false,
    registrationOpenDate: null,
    registrationOpenTime: null,
    registrationStatus: "UNKNOWN",
    sourceType: "SCRAPER",
    sourceUrl: "https://example.test/camp",
    dataConfidence: "VERIFIED",
    ageGroups: [],
    schedules: [],
    pricing: [],
  };
}

/** A scraper that fetches fine and extracts one camp. */
class HealthyScraper extends BaseScraper {
  readonly scraperName = "Healthy Source";
  readonly sourceKey = "test-healthy";
  readonly entryUrl = "https://healthy.example.test/camps";

  protected async fetchPage(url: string): Promise<ScrapeContext> {
    const html = "<html></html>";
    return { $: cheerio.load(html), html, url };
  }

  async scrape(_ctx: ScrapeContext): Promise<CampInput[]> {
    return [minimalCamp("healthy-camp")];
  }
}

/**
 * A scraper simulating a 404'd source (like the real Denver Art Museum
 * incident): fetchPage throws an HTTP error, scrape() is never reached.
 */
class DeadScraper extends BaseScraper {
  readonly scraperName = "Dead Source";
  readonly sourceKey = "test-dead";
  readonly entryUrl = "https://dead.example.test/camps";

  protected async fetchPage(url: string): Promise<ScrapeContext> {
    throw new Error(`HTTP 404 for ${url}`);
  }

  async scrape(_ctx: ScrapeContext): Promise<CampInput[]> {
    throw new Error("scrape() should not be reached when fetchPage() throws");
  }
}

/** A scraper whose fetch succeeds but scrape() throws unexpectedly. */
class ParseFailureScraper extends BaseScraper {
  readonly scraperName = "Parse Failure Source";
  readonly sourceKey = "test-parse-failure";
  readonly entryUrl = "https://parsefail.example.test/camps";

  protected async fetchPage(url: string): Promise<ScrapeContext> {
    const html = "<html></html>";
    return { $: cheerio.load(html), html, url };
  }

  async scrape(_ctx: ScrapeContext): Promise<CampInput[]> {
    throw new Error("unexpected parse exception");
  }
}

// ─── 1. BaseScraper.run() never throws ─────────────────────────────────

async function testRunNeverThrows() {
  const dead = new DeadScraper();
  const result = await dead.run();
  assert.deepEqual(result.camps, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /HTTP 404/);

  const healthy = new HealthyScraper();
  const healthyResult = await healthy.run();
  assert.equal(healthyResult.camps.length, 1);
  assert.deepEqual(healthyResult.errors, []);

  console.log("✓ BaseScraper.run() never throws on HTTP errors");
}

// ─── 2. runScraperSafe isolates a source failure ───────────────────────

async function testRunScraperSafeIsolatesFailure() {
  const entry = await runScraperSafe(new DeadScraper());
  assert.equal(entry.ok, false);
  assert.equal(entry.found, 0);
  assert.equal(entry.upserted, 0);
  assert.equal(entry.errors.length, 1);
  assert.match(entry.errors[0], /HTTP 404/);
  assert.equal(entry.scraper, "Dead Source");
  assert.equal(entry.url, "https://dead.example.test/camps");

  console.log("✓ runScraperSafe() records a source-level failure without throwing");
}

// ─── 3. Mid-list continuation: a dead source doesn't stop the next one ──

async function testMidListContinuation() {
  const scrapers: BaseScraper[] = [
    new HealthyScraper(),
    new DeadScraper(),
    new ParseFailureScraper(),
    new HealthyScraper(),
  ];

  const report: ScraperReportEntry[] = [];
  for (const scraper of scrapers) {
    // Mirrors the loop in scripts/scrape.ts — must not throw for any entry.
    const entry = await runScraperSafe(scraper);
    report.push(entry);
  }

  assert.equal(report.length, 4, "all sources should have been attempted, including after failures");
  assert.equal(report[0].ok, true);
  assert.equal(report[1].ok, false);
  assert.equal(report[2].ok, false);
  assert.equal(report[3].ok, true, "the source after two failures must still run");
  assert.equal(report[3].found, 1);

  console.log("✓ a dead/failing source mid-list does not prevent later sources from running");
}

// ─── 4. Per-camp upsert failures are isolated too ──────────────────────

async function testPerCampUpsertIsolation() {
  const camps = ["a", "b", "c"];
  let call = 0;
  const upsert = async (camp: CampInput) => {
    call++;
    if (camp.name === "b") throw new Error("db conflict for b");
  };

  class ThreeCampScraper extends BaseScraper {
    readonly scraperName = "Three Camp Source";
  readonly sourceKey = "test-three-camp";
    readonly entryUrl = "https://threecamp.example.test";
    protected async fetchPage(url: string): Promise<ScrapeContext> {
      return { $: cheerio.load("<html></html>"), html: "<html></html>", url };
    }
    async scrape(): Promise<CampInput[]> {
      return camps.map((n) => minimalCamp(n));
    }
  }

  const entry = await runScraperSafe(new ThreeCampScraper(), upsert);
  assert.equal(call, 3, "upsert should be attempted for every camp despite one failing");
  assert.equal(entry.upserted, 2);
  assert.equal(entry.found, 3);
  assert.equal(entry.errors.length, 1);
  assert.match(entry.errors[0], /db conflict for b/);
  assert.equal(entry.ok, true, "source itself succeeded even though one camp failed to upsert");

  console.log("✓ a per-camp upsert failure does not stop remaining camps from upserting");
}

// ─── 5. Threshold behavior ──────────────────────────────────────────────

function entry(ok: boolean, name = "s"): ScraperReportEntry {
  return { scraper: name, url: `https://${name}.test`, ok, found: ok ? 1 : 0, upserted: ok ? 1 : 0, errors: ok ? [] : ["boom"], camps: [] };
}

function testThresholdBehavior() {
  // Real-world incident shape: 2 sources registered, 1 (DAM) is dead.
  // Exactly 50% failure — must NOT trip the default >50% threshold.
  const oneOfTwoFailed = summarizeReport([entry(true, "avid4"), entry(false, "dam")]);
  assert.equal(oneOfTwoFailed.failureRatio, 0.5);
  assert.equal(oneOfTwoFailed.shouldExitNonZero, false, "a single dead source among 2 must not fail the sweep");

  // Zero successes must always fail, regardless of ratio math.
  const allFailed = summarizeReport([entry(false, "a"), entry(false, "b")]);
  assert.equal(allFailed.shouldExitNonZero, true, "zero successful sources must fail the sweep");

  // Majority failing (3 of 4 = 75% > 50%) must fail.
  const majorityFailed = summarizeReport([entry(true, "a"), entry(false, "b"), entry(false, "c"), entry(false, "d")]);
  assert.equal(majorityFailed.shouldExitNonZero, true, "a majority of sources failing must fail the sweep");

  // A custom, stricter threshold (0.2) should fail even on the 1-of-2 case.
  const strict = summarizeReport([entry(true, "avid4"), entry(false, "dam")], 0.2);
  assert.equal(strict.shouldExitNonZero, true, "a stricter threshold should fail on the same 1-of-2 failure");

  // Empty report (no scrapers matched --scraper filter) should not claim failure.
  const empty = summarizeReport([]);
  assert.equal(empty.shouldExitNonZero, false);

  console.log("✓ summarizeReport() threshold behavior matches the documented policy");
}

function testResolveFailureThreshold() {
  assert.equal(resolveFailureThreshold(undefined), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold(""), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold("0.2"), 0.2);
  assert.equal(resolveFailureThreshold("1"), 1);
  assert.equal(resolveFailureThreshold("0"), 0);
  assert.equal(resolveFailureThreshold("not-a-number"), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold("-1"), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold("2"), DEFAULT_FAILURE_THRESHOLD_RATIO);

  console.log("✓ resolveFailureThreshold() parses env input with sane fallback");
}

// ─── Run ─────────────────────────────────────────────────────────────────

async function main() {
  await testRunNeverThrows();
  await testRunScraperSafeIsolatesFailure();
  await testMidListContinuation();
  await testPerCampUpsertIsolation();
  testThresholdBehavior();
  testResolveFailureThreshold();
  console.log("\nscrape error-handling verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
