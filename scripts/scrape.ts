/**
 * scrape.ts — Ingestion sweep runner (full traverse cutover, owner
 * directive 2026-07).
 *
 * Runs every configured source (lib/ingestion/sources.ts) through the
 * traverse pipeline (lib/ingestion/traverse-pipeline.ts): fetch with
 * snapshot capture -> per-item schema-directed extraction -> route each
 * item to the review sink (createProposal). There is no more CSS-selector
 * scraper registry, no more TRAVERSE_INGESTION flag, and no more legacy
 * shadow run — traverse is the only ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/scrape.ts                    # Run all sources
 *   npx tsx scripts/scrape.ts --dry-run           # Extract but don't write to DB
 *   npx tsx scripts/scrape.ts --source avid4      # Run a single source
 */

import { Client } from "pg";
import { INGESTION_SOURCES } from "@/lib/ingestion/sources";
import { slugify } from "@/lib/ingestion/slug";
import {
  runTraversePipeline,
  type TraverseProposalSink,
} from "@/lib/ingestion/traverse-pipeline";
import { createCampfitSnapshotStore } from "@/lib/ingestion/traverse-snapshot-store";
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { createProposal } from "@/lib/admin/review-repository";
import { createCrawlRun, completeCrawlRun } from "@/lib/admin/crawl-repository";
import { DatumError } from "@kontourai/datum";
import { resolvePgConfig } from "@/lib/db-config";
import { loadLocalEnv } from "./load-env";
import {
  toIngestionReportEntry,
  summarizeReport,
  printReport,
  resolveFailureThreshold,
} from "@/lib/ingestion/ingestion-runner";

loadLocalEnv();

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

// ─── Per-item anchor camp ─────────────────────────────────────────────────

const CURRENT_VALUE_COLUMNS =
  `name, description, category, "registrationStatus", "applicationUrl", "websiteUrl", city, neighborhood, address`;

/** Look up an existing Camp's current field values by `slugify(itemName)`, if any. */
async function lookupCurrentBySlug(client: Client, itemName: string): Promise<Record<string, unknown> | null> {
  const slug = slugify(itemName);
  if (!slug) return null;
  const { rows } = await client.query(
    `SELECT id, ${CURRENT_VALUE_COLUMNS} FROM "Camp" WHERE slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

/**
 * Ensure a stable Camp row exists for one traverse-extracted item so its
 * proposals have a campId to attach a CampChangeProposal to. Idempotent
 * upsert keyed by `slugify(itemName)` — the same slug convention the legacy
 * scrapers used, so an item that already exists as a Camp (from a prior
 * source, e.g. CSV seed data) reuses that row rather than creating a
 * duplicate.
 */
async function ensureAnchorCamp(
  client: Client,
  itemName: string,
  sourceUrl: string
): Promise<string> {
  const slug = slugify(itemName) || `item-${Date.now()}`;

  const existing = await client.query(`SELECT id FROM "Camp" WHERE slug = $1`, [slug]);
  if (existing.rows.length > 0) return existing.rows[0].id as string;

  const inserted = await client.query(
    `INSERT INTO "Camp" (
       id, slug, name, description, notes, "campType", category, "websiteUrl",
       "interestingDetails", city, neighborhood, address, "lunchIncluded",
       "registrationStatus", "sourceType", "sourceUrl", "dataConfidence", "lastVerifiedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, '', NULL, 'SUMMER_DAY'::"CampType",
       'OTHER'::"CampCategory", $3, NULL, '', '', '', false,
       'UNKNOWN'::"RegistrationStatus", 'SCRAPER'::"SourceType", $3,
       'PLACEHOLDER'::"DataConfidence", NOW()
     )
     RETURNING id`,
    [slug, itemName, sourceUrl]
  );
  return inserted.rows[0].id as string;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlySource = args.includes("--source")
    ? args[args.indexOf("--source") + 1]
    : null;

  console.log(`\n🧭 CampFit Traverse Ingestion${dryRun ? " (DRY RUN)" : ""}\n`);

  const sources = onlySource
    ? INGESTION_SOURCES.filter((s) => s.key === onlySource)
    : INGESTION_SOURCES;

  if (sources.length === 0) {
    console.error(`No source found matching: ${onlySource}`);
    process.exit(1);
  }

  let provider;
  try {
    provider = resolveExtractionProvider().provider;
  } catch (err) {
    if (err instanceof DatumError) {
      console.error(`❌ Could not resolve an extraction provider (${err.code}): ${err.message}`);
      console.error(`   export ZAI_API_KEY=... (or add it to .env.local) and retry.`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Provider: ${provider.name}\n`);

  let client: Client | null = null;
  if (!dryRun) {
    client = getClient();
    await client.connect();
    console.log("✓ Connected to Supabase\n");
  }

  const store = createCampfitSnapshotStore();

  let crawlRunId: string | null = null;
  if (!dryRun) {
    const crawlRun = await createCrawlRun({
      triggeredBy: "scrape:traverse-pipeline",
      trigger: "SCHEDULED",
      totalCamps: sources.length,
    });
    crawlRunId = crawlRun.id;
  }

  const sink: TraverseProposalSink = async (record, meta) => {
    if (dryRun || !client || !crawlRunId) return null;
    const campId = await ensureAnchorCamp(client, record.itemName, meta.sourceUrl);
    return createProposal({
      campId,
      crawlRunId,
      sourceUrl: meta.sourceUrl,
      rawExtraction: record.rawExtraction,
      proposedChanges: record.proposedChanges,
      overallConfidence: record.overallConfidence,
      extractionModel: record.extractionModel,
    });
  };

  const results = await runTraversePipeline(sources, {
    provider,
    store,
    sink,
    mode: "live-with-capture",
    currentByItemNames: async (_sourceKey, itemNames) => {
      const out = new Map<string, Record<string, unknown>>();
      if (dryRun || !client) return out;
      for (const name of itemNames) {
        const current = await lookupCurrentBySlug(client, name);
        if (current) out.set(name, current);
      }
      return out;
    },
  });

  if (client && crawlRunId) {
    const errorLog = results
      .filter((r) => r.fetchError || r.extractionError)
      .map((r) => ({ campId: "", error: r.fetchError ?? r.extractionError ?? "", url: r.url }));
    await completeCrawlRun(crawlRunId, "COMPLETED", errorLog);
  }

  if (client) await client.end();

  const report = results.map(toIngestionReportEntry);
  const thresholdRatio = resolveFailureThreshold(process.env.SCRAPE_FAILURE_THRESHOLD);
  const summary = summarizeReport(report, thresholdRatio);
  printReport(report, summary);

  if (summary.shouldExitNonZero) {
    console.error(`\n❌ Ingestion sweep failed: ${summary.reasonLine}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
