/**
 * POST /api/admin/scrape — manually trigger an ingestion sweep (full
 * traverse cutover, owner directive 2026-07). Protected by CRON_SECRET.
 *
 * Body: { source?: string, dryRun?: boolean }
 *
 * dryRun=true runs fetch+extraction (in "live" fetch mode, no snapshot
 * persisted) and reports items found WITHOUT calling the review sink (no DB
 * write) — mirrors the old scraper route's dry-run contract. dryRun=false
 * runs the full pipeline (snapshot capture + routing to createProposal).
 *
 * Note: Vercel serverless functions have a 10s default timeout.
 * For long-running sweeps, use GitHub Actions (.github/workflows/scrape.yml)
 * instead. This route is best used for quick single-source dry runs.
 */

import { NextResponse } from "next/server";
import { INGESTION_SOURCES } from "@/lib/ingestion/sources";
import { slugify } from "@/lib/ingestion/slug";
import { runTraversePipeline, type TraverseProposalSink } from "@/lib/ingestion/traverse-pipeline";
import { createInMemorySnapshotStore, createFilesystemSnapshotStore } from "@kontourai/traverse/fetch";
import { SNAPSHOT_STORE_ROOT } from "@/lib/ingestion/traverse-snapshot-store";
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { createProposal } from "@/lib/admin/review-repository";
import { createCrawlRun, completeCrawlRun } from "@/lib/admin/crawl-repository";
import { getPool } from "@/lib/db";
import { DatumError } from "@kontourai/datum";

export const maxDuration = 60; // Vercel Pro allows up to 300s

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { source: sourceKey, dryRun = true } = await request.json();

  const sources = sourceKey
    ? INGESTION_SOURCES.filter((s) => s.key === sourceKey)
    : INGESTION_SOURCES;
  if (sourceKey && sources.length === 0) {
    return NextResponse.json(
      { error: `Unknown source: ${sourceKey}`, available: INGESTION_SOURCES.map((s) => s.key) },
      { status: 400 }
    );
  }

  let provider;
  try {
    provider = resolveExtractionProvider().provider;
  } catch (err) {
    if (err instanceof DatumError) {
      return NextResponse.json(
        { error: `Could not resolve an extraction provider (${err.code}): ${err.message}` },
        { status: 500 }
      );
    }
    throw err;
  }

  // dryRun: extract only, no persisted snapshot, no DB write — an in-memory
  // store satisfies fetchAndExtract's "live" mode requirement without ever
  // touching the filesystem or the review sink.
  const store = dryRun
    ? createInMemorySnapshotStore()
    : createFilesystemSnapshotStore({ root: SNAPSHOT_STORE_ROOT });

  let crawlRunId: string | null = null;
  if (!dryRun) {
    const crawlRun = await createCrawlRun({
      triggeredBy: "admin-api:scrape",
      trigger: "MANUAL",
      totalCamps: sources.length,
    });
    crawlRunId = crawlRun.id;
  }

  const sink: TraverseProposalSink = async (record, meta) => {
    if (dryRun || !crawlRunId) return null;
    const pool = getPool();
    const slug = slugify(record.itemName) || `item-${Date.now()}`;
    const existing = await pool.query(`SELECT id FROM "Camp" WHERE slug = $1`, [slug]);
    let campId: string;
    if (existing.rows.length > 0) {
      campId = existing.rows[0].id as string;
    } else {
      const inserted = await pool.query(
        `INSERT INTO "Camp" (
           id, slug, name, description, notes, "campType", category, "websiteUrl",
           "interestingDetails", city, neighborhood, address, "lunchIncluded",
           "registrationStatus", "sourceType", "sourceUrl", "dataConfidence", "lastVerifiedAt"
         ) VALUES (
           gen_random_uuid()::text, $1, $2, '', NULL, 'SUMMER_DAY'::"CampType",
           'OTHER'::"CampCategory", $3, NULL, '', '', '', false,
           'UNKNOWN'::"RegistrationStatus", 'SCRAPER'::"SourceType", $3,
           'PLACEHOLDER'::"DataConfidence", NOW()
         ) RETURNING id`,
        [slug, record.itemName, meta.sourceUrl]
      );
      campId = inserted.rows[0].id as string;
    }
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
    mode: dryRun ? "live" : "live-with-capture",
  });

  if (crawlRunId) {
    const errorLog = results
      .filter((r) => r.fetchError || r.extractionError)
      .map((r) => ({ campId: "", error: r.fetchError ?? r.extractionError ?? "", url: r.url }));
    await completeCrawlRun(crawlRunId, "COMPLETED", errorLog);
  }

  return NextResponse.json({
    results: results.map((r) => ({
      source: r.source,
      url: r.url,
      ok: r.ok,
      itemCount: r.itemCount,
      routedFieldCount: r.routedFieldCount,
      tokensUsed: r.tokensUsed,
      model: r.model,
      latencyMs: r.latencyMs,
      fetchError: r.fetchError,
      extractionError: r.extractionError,
      warnings: r.warnings,
    })),
  });
}
