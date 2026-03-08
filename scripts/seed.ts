/**
 * seed.ts — CSV → Supabase seeder
 *
 * Reads all 4 Denver Camps CSV files, normalizes each row using
 * CsvIngestionAdapter, then upserts into Supabase via pg.
 *
 * Run with: npx tsx scripts/seed.ts
 */

import * as fs from "fs";
import * as path from "path";
import { parse } from "csv-parse/sync";
import { Client } from "pg";
import { CsvIngestionAdapter, CsvFileType } from "@/lib/ingestion/csv-adapter";
import { CampInput } from "@/lib/ingestion/adapter";

// ─── Config ──────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");

const CSV_FILES: { file: string; type: CsvFileType }[] = [
  { file: "Denver Camps 2026.xlsx.csv", type: "summer" },
  { file: "Denver Camps 2026.sleepaway.xlsx.csv", type: "sleepaway" },
  { file: "Denver Camps 2026.family.xlsx.csv", type: "family" },
  { file: "Denver Camps 2026.winter.xlsx.csv", type: "winter" },
  { file: "Denver Camps 2026.break.xlsx.csv", type: "break" },
  { file: "Denver Camps 2026.virtual.xlsx.csv", type: "virtual" },
];

// ─── DB Connection ───────────────────────────────────────────

function getClient(): Client {
  // Use Supabase connection pooler (direct host is IPv6-only, unreachable from Termux)
  return new Client({
    host: "aws-0-us-west-2.pooler.supabase.com",
    port: 6543,
    database: "postgres",
    user: "postgres.rpnzolnnhbzhuspwpajq",
    password: "eDG*8dX-c#eD2Z2",
    ssl: { rejectUnauthorized: false },
  });
}

// ─── CSV Reader ───────────────────────────────────────────────

function readCsv(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf-8");

  // Skip the first row if it's a notes/instructions row (not a header)
  // The main CSV has a notes row before the actual header
  const lines = content.split("\n");
  let startLine = 0;

  // Find the actual header row (contains "Name" and "Category")
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].includes('"Name"') || lines[i].includes(",Name,")) {
      startLine = i;
      break;
    }
  }

  const csvContent = lines.slice(startLine).join("\n");

  try {
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];

    return records;
  } catch (e) {
    console.error(`  Parse error: ${e}`);
    return [];
  }
}

// ─── DB Upsert ────────────────────────────────────────────────

async function upsertCamp(client: Client, camp: CampInput): Promise<string | null> {
  // Upsert camp (insert or update on slug conflict)
  const campResult = await client.query(
    `INSERT INTO "Camp" (
      id, slug, name, description, notes, "campType", category,
      "websiteUrl", "interestingDetails", city, region, neighborhood,
      address, latitude, longitude, "lunchIncluded",
      "registrationOpenDate", "registrationOpenTime", "registrationStatus",
      "sourceType", "sourceUrl", "dataConfidence", "lastVerifiedAt"
    ) VALUES (
      gen_random_uuid()::text, $1, $2, $3, $4, $5::\"CampType\", $6::\"CampCategory\",
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15,
      $16::date, $17, $18::\"RegistrationStatus\",
      $19::\"SourceType\", $20, $21::\"DataConfidence\", NOW()
    )
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      notes = EXCLUDED.notes,
      "campType" = EXCLUDED."campType",
      category = EXCLUDED.category,
      "websiteUrl" = EXCLUDED."websiteUrl",
      "interestingDetails" = EXCLUDED."interestingDetails",
      city = EXCLUDED.city,
      neighborhood = EXCLUDED.neighborhood,
      address = EXCLUDED.address,
      "lunchIncluded" = EXCLUDED."lunchIncluded",
      "registrationOpenDate" = EXCLUDED."registrationOpenDate",
      "registrationOpenTime" = EXCLUDED."registrationOpenTime",
      "registrationStatus" = EXCLUDED."registrationStatus",
      "dataConfidence" = EXCLUDED."dataConfidence",
      "updatedAt" = NOW()
    RETURNING id`,
    [
      camp.slug,
      camp.name,
      camp.description,
      camp.notes,
      camp.campType,
      camp.category,
      camp.websiteUrl,
      camp.interestingDetails,
      camp.city,
      camp.region,
      camp.neighborhood,
      camp.address,
      camp.latitude,
      camp.longitude,
      camp.lunchIncluded,
      camp.registrationOpenDate,
      camp.registrationOpenTime,
      camp.registrationStatus,
      camp.sourceType,
      camp.sourceUrl,
      camp.dataConfidence,
    ]
  );

  const campId = campResult.rows[0]?.id;
  if (!campId) return null;

  // Delete and re-insert child records (simpler than diffing)
  await client.query(`DELETE FROM "CampAgeGroup" WHERE "campId" = $1`, [campId]);
  await client.query(`DELETE FROM "CampSchedule" WHERE "campId" = $1`, [campId]);
  await client.query(`DELETE FROM "CampPricing" WHERE "campId" = $1`, [campId]);

  // Insert age groups
  for (const ag of camp.ageGroups) {
    await client.query(
      `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
      [campId, ag.label, ag.minAge, ag.maxAge, ag.minGrade, ag.maxGrade]
    );
  }

  // Insert schedules
  for (const s of camp.schedules) {
    await client.query(
      `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff", "latePickup")
       VALUES (gen_random_uuid()::text, $1, $2, $3::date, $4::date, $5, $6, $7, $8)`,
      [campId, s.label, s.startDate, s.endDate, s.startTime, s.endTime, s.earlyDropOff, s.latePickup]
    );
  }

  // Insert pricing
  for (const p of camp.pricing) {
    await client.query(
      `INSERT INTO "CampPricing" (id, "campId", label, amount, unit, "durationWeeks", "ageQualifier", "discountNotes")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::\"PricingUnit\", $5, $6, $7)`,
      [campId, p.label, p.amount, p.unit, p.durationWeeks, p.ageQualifier, p.discountNotes]
    );
  }

  return campId;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("🏕️  CampScout Seed Script\n");

  // Load .env manually
  try {
    const envContent = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch {
    // .env not found, rely on environment
  }

  const client = getClient();

  try {
    await client.connect();
    console.log("✓ Connected to Supabase\n");
  } catch (e) {
    console.error("✗ Connection failed:", e);
    process.exit(1);
  }

  let totalCreated = 0;
  let totalSkipped = 0;
  const allErrors: { file: string; name: string; error: string }[] = [];

  for (const { file, type } of CSV_FILES) {
    const filePath = path.join(DATA_DIR, file);

    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  Skipping ${file} — not found`);
      continue;
    }

    console.log(`📄 Processing ${file} (${type})...`);

    const rows = readCsv(filePath);
    console.log(`   ${rows.length} rows read`);

    const adapter = new CsvIngestionAdapter(rows, type);
    let created = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      try {
        const camp = adapter.normalize(rows[i]);

        if (!camp) {
          skipped++;
          continue;
        }

        await upsertCamp(client, camp);
        created++;

        if (created % 25 === 0) {
          process.stdout.write(`   ${created} camps written...\r`);
        }
      } catch (e) {
        const name = rows[i]["Name"] || rows[i]["name"] || `Row ${i}`;
        const error = e instanceof Error ? e.message : String(e);
        allErrors.push({ file, name, error });
        skipped++;
      }
    }

    console.log(`   ✓ ${created} camps seeded, ${skipped} skipped`);
    totalCreated += created;
    totalSkipped += skipped;
  }

  await client.end();

  console.log(`\n✅ Seed complete!`);
  console.log(`   ${totalCreated} camps written to Supabase`);
  console.log(`   ${totalSkipped} rows skipped`);

  if (allErrors.length > 0) {
    console.log(`\n⚠️  ${allErrors.length} errors:`);
    allErrors.slice(0, 10).forEach((e) =>
      console.log(`   [${e.file}] ${e.name}: ${e.error}`)
    );
    if (allErrors.length > 10) {
      console.log(`   ... and ${allErrors.length - 10} more`);
    }
  }
}

main().catch(console.error);
