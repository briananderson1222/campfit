/**
 * POST /api/admin/scrape — manually trigger a scraper run.
 * Protected by CRON_SECRET.
 *
 * Body: { scraper?: string, dryRun?: boolean }
 *
 * Note: Vercel serverless functions have a 10s default timeout.
 * For long-running scrapes, use GitHub Actions instead.
 * This route is best used for quick single-scraper dry runs.
 */

import { NextResponse } from "next/server";
import { Avid4Scraper } from "@/lib/ingestion/scrapers/avid4";
import { DenverArtMuseumScraper } from "@/lib/ingestion/scrapers/denver-arts";
import { BaseScraper } from "@/lib/ingestion/scraper-base";

const SCRAPERS: Record<string, BaseScraper> = {
  avid4: new Avid4Scraper(),
  "denver-arts": new DenverArtMuseumScraper(),
};

export const maxDuration = 60; // Vercel Pro allows up to 300s

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { scraper: scraperKey, dryRun = true } = await request.json();

  const scraper = scraperKey ? SCRAPERS[scraperKey] : null;
  if (scraperKey && !scraper) {
    return NextResponse.json(
      { error: `Unknown scraper: ${scraperKey}`, available: Object.keys(SCRAPERS) },
      { status: 400 }
    );
  }

  const targets = scraper ? [scraper] : Object.values(SCRAPERS);
  const results = [];

  for (const s of targets) {
    try {
      const { camps, errors } = await s.run();
      results.push({
        scraper: s.scraperName,
        found: camps.length,
        dryRun,
        errors,
        sample: dryRun ? camps.slice(0, 3).map((c) => ({ name: c.name, category: c.category })) : undefined,
      });
    } catch (e) {
      results.push({
        scraper: s.scraperName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({ results });
}
