/**
 * scraper-base.ts — Abstract base class for web scrapers.
 *
 * Each camp site gets its own subclass that overrides `scrape()`.
 * The base class handles: fetch with retries, HTML parsing via cheerio,
 * rate limiting, upsert to Supabase, and diff reporting.
 *
 * Usage:
 *   class Avid4Scraper extends BaseScraper { ... }
 *   const result = await new Avid4Scraper().run();
 */

import * as cheerio from "cheerio";
import { CampInput, IngestionResult, SourceType } from "./adapter";
import { slugify } from "./scraper-utils";

export interface ScrapeContext {
  /** cheerio load() for the main page */
  $: cheerio.CheerioAPI;
  /** Raw HTML of the fetched page */
  html: string;
  /** URL that was fetched */
  url: string;
}

export abstract class BaseScraper {
  readonly sourceType: SourceType = "SCRAPER";

  /** The entry-point URL to start scraping */
  abstract readonly entryUrl: string;

  /** Human-readable name for logging */
  abstract readonly scraperName: string;

  /**
   * Subclasses implement this to extract CampInput[] from the page.
   * May fetch additional pages (detail pages, pagination, etc.)
   */
  abstract scrape(ctx: ScrapeContext): Promise<CampInput[]>;

  /**
   * Fetch a URL with retry + User-Agent header.
   * Returns cheerio context + raw HTML.
   */
  protected async fetchPage(url: string, retries = 3): Promise<ScrapeContext> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; CampScoutBot/1.0; +https://campscout.app/bot)",
            Accept: "text/html,application/xhtml+xml,*/*",
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

        const html = await res.text();
        const $ = cheerio.load(html);
        return { $, html, url };
      } catch (err) {
        if (attempt === retries) throw err;
        await delay(attempt * 1500);
      }
    }
    throw new Error("unreachable");
  }

  /**
   * Fetch JSON from an API endpoint (e.g., a registration system's REST API).
   */
  protected async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "CampScoutBot/1.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json() as Promise<T>;
  }

  /**
   * Rate limit — pause between page fetches to be polite.
   */
  protected async rateLimit(ms = 1000): Promise<void> {
    await delay(ms);
  }

  /**
   * Main entrypoint — runs the scraper and returns results.
   */
  async run(): Promise<{ camps: CampInput[]; errors: string[] }> {
    console.log(`\n[${this.scraperName}] Starting scrape of ${this.entryUrl}`);

    const ctx = await this.fetchPage(this.entryUrl);
    const camps = await this.scrape(ctx);

    console.log(`[${this.scraperName}] Extracted ${camps.length} camps`);
    return { camps, errors: [] };
  }
}

// ─── Shared utilities ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
