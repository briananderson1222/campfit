/**
 * scrape.ts — Web scraper runner
 *
 * Runs all registered scrapers, normalizes results, and upserts to Supabase.
 *
 * Usage:
 *   npx tsx scripts/scrape.ts              # Run all scrapers
 *   npx tsx scripts/scrape.ts --dry-run    # Extract but don't write to DB
 *   npx tsx scripts/scrape.ts --scraper avid4  # Run a single scraper
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";
import { BaseScraper } from "@/lib/ingestion/scraper-base";
import { Avid4Scraper } from "@/lib/ingestion/scrapers/avid4";
import { DenverArtMuseumScraper } from "@/lib/ingestion/scrapers/denver-arts";
import { CampInput } from "@/lib/ingestion/adapter";
import {
  isTraverseIngestionEnabled,
  isRottedSource,
  runTraverseIngestion,
  type TraverseProposalSink,
  type TraverseIngestionSourceResult,
} from "@/lib/ingestion/traverse-ingestion";
import { createCampfitSnapshotStore } from "@/lib/ingestion/traverse-snapshot-store";
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { createProposal } from "@/lib/admin/review-repository";
import { createCrawlRun, completeCrawlRun } from "@/lib/admin/crawl-repository";
import { DatumError } from "@kontourai/datum";
import { resolvePgConfig } from "@/lib/db-config";
import { loadLocalEnv } from "./load-env";
import {
  runScraperSafe,
  summarizeReport,
  printReport,
  resolveFailureThreshold,
  ScraperReportEntry,
} from "@/lib/ingestion/scrape-runner";

loadLocalEnv();

// ─── Registry — add new scrapers here ─────────────────────────────────────

const SCRAPERS: BaseScraper[] = [
  new Avid4Scraper(),
  new DenverArtMuseumScraper(),
  // new CodeNinjasScraper(),
  // new DenverParksRecScraper(),
  // new YmcaScraper(),
];

// ─── DB connection ────────────────────────────────────────────────────────

function getClient(): Client {
  const config = resolvePgConfig();
  if (!config) {
    throw new Error("Missing database env vars for scrape script");
  }

  return new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── DB Upsert (same as seed.ts) ─────────────────────────────────────────

async function upsertCamp(client: Client, camp: CampInput): Promise<string | null> {
  const result = await client.query(
    `INSERT INTO "Camp" (
      id, slug, name, description, notes, "campType", category,
      "websiteUrl", "interestingDetails", city, region, neighborhood,
      address, latitude, longitude, "lunchIncluded",
      "registrationOpenDate", "registrationOpenTime", "registrationStatus",
      "sourceType", "sourceUrl", "dataConfidence", "lastVerifiedAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5::"CampType", $6::"CampCategory",
      $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16::date, $17, $18::"RegistrationStatus",
      $19::"SourceType", $20, $21::"DataConfidence", NOW()
    )
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      "campType" = EXCLUDED."campType",
      category = EXCLUDED.category,
      "websiteUrl" = EXCLUDED."websiteUrl",
      "interestingDetails" = EXCLUDED."interestingDetails",
      city = EXCLUDED.city,
      neighborhood = EXCLUDED.neighborhood,
      address = EXCLUDED.address,
      "registrationStatus" = EXCLUDED."registrationStatus",
      "dataConfidence" = EXCLUDED."dataConfidence",
      "sourceUrl" = EXCLUDED."sourceUrl",
      "lastVerifiedAt" = NOW(),
      "updatedAt" = NOW()
    RETURNING id`,
    [
      camp.slug, camp.name, camp.description, camp.notes,
      camp.campType, camp.category, camp.websiteUrl, camp.interestingDetails,
      camp.city, camp.region, camp.neighborhood, camp.address,
      camp.latitude, camp.longitude, camp.lunchIncluded,
      camp.registrationOpenDate, camp.registrationOpenTime, camp.registrationStatus,
      camp.sourceType, camp.sourceUrl, camp.dataConfidence,
    ]
  );

  const campId = result.rows[0]?.id;
  if (!campId) return null;

  await client.query(`DELETE FROM "CampAgeGroup" WHERE "campId" = $1`, [campId]);
  await client.query(`DELETE FROM "CampSchedule" WHERE "campId" = $1`, [campId]);
  await client.query(`DELETE FROM "CampPricing" WHERE "campId" = $1`, [campId]);

  for (const ag of camp.ageGroups) {
    await client.query(
      `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
      [campId, ag.label, ag.minAge, ag.maxAge, ag.minGrade, ag.maxGrade]
    );
  }

  for (const s of camp.schedules) {
    await client.query(
      `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff", "latePickup")
       VALUES (gen_random_uuid()::text, $1, $2, $3::date, $4::date, $5, $6, $7, $8)`,
      [campId, s.label, s.startDate, s.endDate, s.startTime, s.endTime, s.earlyDropOff, s.latePickup]
    );
  }

  for (const p of camp.pricing) {
    await client.query(
      `INSERT INTO "CampPricing" (id, "campId", label, amount, unit, "durationWeeks", "ageQualifier", "discountNotes")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::"PricingUnit", $5, $6, $7)`,
      [campId, p.label, p.amount, p.unit, p.durationWeeks, p.ageQualifier, p.discountNotes]
    );
  }

  return campId;
}

// ─── Traverse ingestion anchor (Slice 2b, flag TRAVERSE_INGESTION) ──────────

/**
 * Ensure a stable per-source "anchor" Camp exists so traverse's page-level
 * proposals have a campId to attach a CampChangeProposal to. Idempotent upsert
 * by a deterministic slug; returns the camp id. Only reached on the flagged
 * ingestion path (never in the default sweep).
 */
async function ensureAnchorCamp(
  client: Client,
  sourceKey: string,
  url: string
): Promise<string> {
  const slug = `traverse-${sourceKey}`;
  const res = await client.query(
    `INSERT INTO "Camp" (
       id, slug, name, description, notes, "campType", category, "websiteUrl",
       "interestingDetails", city, neighborhood, address, "lunchIncluded",
       "registrationStatus", "sourceType", "sourceUrl", "dataConfidence", "lastVerifiedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, '', NULL, 'SUMMER_DAY'::"CampType",
       'OTHER'::"CampCategory", $3, NULL, '', '', '', false,
       'UNKNOWN'::"RegistrationStatus", 'SCRAPER'::"SourceType", $3,
       'VERIFIED'::"DataConfidence", NOW()
     )
     ON CONFLICT (slug) DO UPDATE SET "lastVerifiedAt" = NOW()
     RETURNING id`,
    [slug, `${sourceKey} (traverse ingestion anchor)`, url]
  );
  return res.rows[0].id as string;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyScraper = args.includes("--scraper")
    ? args[args.indexOf("--scraper") + 1]
    : null;

  console.log(`\n🕷️  CampFit Scraper${dryRun ? " (DRY RUN)" : ""}\n`);

  const scrapers = onlyScraper
    ? SCRAPERS.filter((s) => s.scraperName.toLowerCase().includes(onlyScraper.toLowerCase()))
    : SCRAPERS;

  if (scrapers.length === 0) {
    console.error(`No scraper found matching: ${onlyScraper}`);
    process.exit(1);
  }

  let client: Client | null = null;
  if (!dryRun) {
    client = getClient();
    await client.connect();
    console.log("✓ Connected to Supabase\n");
  }

  // ── Flagged traverse ingestion (TRAVERSE_INGESTION) ──────────────────────
  // When on, the selector-DEAD sources (avid4, denver-art-museum) route through
  // schema-directed traverse into the review sink (createProposal) instead of
  // their rotted CSS path; the legacy scraper still runs in SHADOW for count
  // telemetry. Healthy sources are untouched. Flag OFF => this block is skipped
  // and the sweep is byte-identical to before. Needs the DB (real sink) + a
  // resolvable extraction provider; degrades to legacy for those sources if
  // either is missing.
  const routedKeys = new Set<string>();
  let traverseResults: TraverseIngestionSourceResult[] = [];
  if (isTraverseIngestionEnabled(process.env)) {
    const rotted = scrapers.filter((sc) => isRottedSource(sc.sourceKey));
    if (dryRun) {
      console.log(`ℹ️  TRAVERSE_INGESTION set but --dry-run: traverse routes to the review sink (a write), skipped in dry-run. ${rotted.length} rotted source(s) fall through to legacy.`);
    } else if (rotted.length > 0 && client) {
      let provider;
      try {
        provider = resolveExtractionProvider().provider;
      } catch (err) {
        if (err instanceof DatumError) {
          console.warn(`⚠️  TRAVERSE_INGESTION on but datum could not resolve a provider (${err.code}): ${err.message} — rotted sources fall through to legacy.`);
        } else {
          throw err;
        }
      }
      if (provider) {
        const store = createCampfitSnapshotStore();
        const crawlRun = await createCrawlRun({
          triggeredBy: "scrape:traverse-ingestion",
          trigger: "SCHEDULED",
          totalCamps: rotted.length,
        });
        const sink: TraverseProposalSink = async (record, meta) => {
          const campId = await ensureAnchorCamp(client as Client, meta.sourceKey, meta.sourceUrl);
          return createProposal({
            campId,
            crawlRunId: crawlRun.id,
            sourceUrl: meta.sourceUrl,
            rawExtraction: record.rawExtraction,
            proposedChanges: record.proposedChanges,
            overallConfidence: record.overallConfidence,
            extractionModel: record.extractionModel,
          });
        };
        traverseResults = await runTraverseIngestion(
          rotted.map((sc) => ({ key: sc.sourceKey, url: sc.entryUrl, scraper: sc })),
          { provider, store, sink }
        );
        for (const r of traverseResults) routedKeys.add(r.source);
        const ingestionErrors = traverseResults
          .filter((r) => r.fetchError || r.extractionError)
          .map((r) => ({ campId: "", error: r.fetchError ?? r.extractionError ?? "", url: r.snapshotRef ?? "" }));
        await completeCrawlRun(crawlRun.id, "COMPLETED", ingestionErrors);
      }
    }
  }

  // Each source is isolated: a dead URL / HTTP error / parse failure for
  // one scraper is caught and recorded here, it never aborts the loop —
  // see lib/ingestion/scrape-runner.ts for the isolation + threshold logic.
  const report: ScraperReportEntry[] = [];

  // Sources handled by traverse ingestion above are not re-run on the legacy
  // path (their legacy scraper already ran in shadow inside runTraverseIngestion).
  const legacyScrapers = scrapers.filter((sc) => !routedKeys.has(sc.sourceKey));

  for (const scraper of legacyScrapers) {
    const entry = await runScraperSafe(
      scraper,
      !dryRun && client
        ? async (camp) => {
            await upsertCamp(client as Client, camp);
          }
        : undefined
    );
    report.push(entry);

    if (dryRun) {
      entry.camps.slice(0, 3).forEach((c) =>
        console.log(`  → ${c.name} | ${c.category} | ${c.schedules.length} sessions`)
      );
    }
  }

  if (client) await client.end();

  if (traverseResults.length > 0) {
    console.log("\n🧭 Traverse ingestion (flagged) — rotted sources routed to review:");
    for (const r of traverseResults) {
      console.log(
        `  • ${r.source}: legacy(shadow)=${r.legacyShadowCount} camps, traverse=${r.traverseProposalCount} proposals ` +
          `(${r.routedFieldCount} fields)${r.routedProposalId ? ` → proposal ${r.routedProposalId}` : ""}` +
          `${r.snapshotBodyHash ? ` [snapshot ${r.snapshotBodyHash.slice(0, 12)}]` : ""}` +
          `${r.fetchError ? ` ✗ fetch ${r.fetchError}` : ""}${r.extractionError ? ` ✗ extract ${r.extractionError}` : ""}`
      );
    }
  }

  const thresholdRatio = resolveFailureThreshold(process.env.SCRAPE_FAILURE_THRESHOLD);
  const summary = summarizeReport(report, thresholdRatio);
  printReport(report, summary);

  if (summary.shouldExitNonZero) {
    console.error(`\n❌ Scrape sweep failed: ${summary.reasonLine}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
