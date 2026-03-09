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
  return new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 6543,
    database: "postgres",
    user: "postgres.rpnzolnnhbzhuspwpajq",
    password: "eDG*8dX-c#eD2Z2",
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

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyScraper = args.includes("--scraper")
    ? args[args.indexOf("--scraper") + 1]
    : null;

  console.log(`\n🕷️  CampScout Scraper${dryRun ? " (DRY RUN)" : ""}\n`);

  // Load .env manually if present
  try {
    const envContent = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch {
    // rely on environment
  }

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

  const report: {
    scraper: string;
    found: number;
    upserted: number;
    errors: string[];
  }[] = [];

  for (const scraper of scrapers) {
    const { camps, errors } = await scraper.run();
    let upserted = 0;

    if (!dryRun && client) {
      for (const camp of camps) {
        try {
          await upsertCamp(client, camp);
          upserted++;
        } catch (e) {
          errors.push(`${camp.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    report.push({
      scraper: scraper.scraperName,
      found: camps.length,
      upserted: dryRun ? 0 : upserted,
      errors,
    });

    if (dryRun) {
      camps.slice(0, 3).forEach((c) =>
        console.log(`  → ${c.name} | ${c.category} | ${c.schedules.length} sessions`)
      );
    }
  }

  if (client) await client.end();

  console.log("\n📊 Scrape Report:");
  console.log("─".repeat(50));
  for (const r of report) {
    const status = r.errors.length > 0 ? "⚠️" : "✅";
    console.log(`${status} ${r.scraper}: ${r.found} found, ${r.upserted} upserted`);
    r.errors.slice(0, 3).forEach((e) => console.log(`   ✗ ${e}`));
  }

  const totalUpserted = report.reduce((s, r) => s + r.upserted, 0);
  const totalErrors = report.reduce((s, r) => s + r.errors.length, 0);
  console.log(`\n✅ Done: ${totalUpserted} camps updated, ${totalErrors} errors`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
