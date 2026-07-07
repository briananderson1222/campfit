/**
 * POST /api/admin/scrape — manually trigger an ingestion sweep (full
 * traverse cutover, owner directive 2026-07). Protected by CRON_SECRET.
 *
 * Body: { source?: string, dryRun?: boolean }
 *
 * dryRun=true runs fetch+extraction (in "live" fetch mode, no snapshot
 * persisted) and reports items found WITHOUT calling the review sink (no DB
 * write) — mirrors the old scraper route's dry-run contract, and stays OFF
 * the shared orchestration seam below: `runCrawlPipeline`'s `sources`
 * strategy always creates a real `CrawlRun` row (no dry-run concept of its
 * own — mirrors `scripts/scrape.ts`'s identical `--dry-run` gating), so a
 * dry run still calls `traverse-pipeline.ts`'s lower-level
 * `runTraversePipeline` directly, exactly as before.
 *
 * dryRun=false runs the full pipeline through `runCrawlPipeline({ sources,
 * ... })` (lib/ingestion/crawl-pipeline.ts) — THE one orchestration seam
 * campfit#85 (WS11 Slice 4) converges every crawl trigger onto. This route
 * no longer hand-rolls `createCrawlRun`/`completeCrawlRun` or its own
 * `ensureAnchorCamp`+sink — the same shared run-record tracker the camp-path
 * re-crawl routes use now backs this sweep too, so it gets live
 * progress/campLog/errorLog writes and a real, joinable failure identifier
 * (`source:<sourceKey>`, never the pre-convergence unjoinable `campId: ""`)
 * for free (see crawl-pipeline.ts's file doc / crawl-run-tracker.ts).
 * `CrawlOptions.onSourceResult` (Wave 4 addition, shared with
 * `scripts/scrape.ts`'s identical need) collects the same per-source
 * `TraversePipelineSourceResult[]` this route always built its response
 * from, since `runCrawlPipeline` itself returns only the final `CrawlRun` —
 * so the response's `results` array keeps its pre-existing per-source shape
 * (source/url/ok/itemCount/routedFieldCount/tokensUsed/model/latencyMs/
 * fetchError/extractionError/warnings) unchanged for API compatibility, with
 * `runId`/`status` added on top (additive — never exposed before) so a
 * caller can also poll `/api/admin/crawl/[runId]/status(-json)` (or the
 * Crawl Monitor UI) for live progress mid-sweep, which this route never
 * offered pre-convergence.
 *
 * Note: Vercel serverless functions have a 10s default timeout.
 * For long-running sweeps, use GitHub Actions (.github/workflows/scrape.yml)
 * instead. This route is best used for quick single-source dry runs.
 */

import { NextResponse } from "next/server";
import { INGESTION_SOURCES } from "@/lib/ingestion/sources";
import {
  runTraversePipeline,
  type TraverseProposalSink,
  type TraversePipelineSourceResult,
} from "@/lib/ingestion/traverse-pipeline";
import { createInMemorySnapshotStore } from "@kontourai/traverse/fetch";
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { runCrawlPipeline } from "@/lib/ingestion/crawl-pipeline";
import { DatumError } from "@kontourai/datum";

export const maxDuration = 60; // Vercel Pro allows up to 300s

function toResponseResult(r: TraversePipelineSourceResult) {
  return {
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
  };
}

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

  if (!dryRun) {
    // Live sweep — converged onto the one orchestration seam (campfit#85,
    // WS11 Slice 4). Provider resolution/init failure is handled INSIDE
    // `runCrawlPipeline` (mirrors the camp-path strategy's
    // `providerInitError` handling): it records a well-defined per-source
    // failure and marks the run FAILED rather than throwing, so a
    // datum/provider config error no longer 500s this request the way the
    // pre-convergence preflight check below (still used for dryRun) did —
    // it surfaces on the returned run/results instead, uniformly with every
    // other crawl-trigger path on this seam.
    const collected: TraversePipelineSourceResult[] = [];
    // campfit#53 (spa-ingestion): no `fetchOptions.renderImpl` is configured
    // here — this is a Vercel serverless route (see this file's own 10s
    // timeout note above), which cannot launch headless Chromium. A
    // `render: true` source swept from here fails closed with traverse's
    // typed `invalid-config` FetchError instead of a crash or a silent
    // unrendered fetch (AC6/AC7). Only `scripts/scrape.ts` (the GitHub
    // Actions sweep) configures a real renderImpl.
    const run = await runCrawlPipeline({
      sources,
      triggeredBy: "admin-api:scrape",
      trigger: "MANUAL",
      onSourceResult: (result) => {
        collected.push(result);
      },
    });

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      results: collected.map(toResponseResult),
    });
  }

  // dryRun: extract only, no persisted snapshot, no DB write, no CrawlRun —
  // an in-memory store satisfies fetchAndExtract's "live" mode requirement
  // without ever touching the filesystem, the review sink, or the tracker.
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

  const store = createInMemorySnapshotStore();
  const sink: TraverseProposalSink = async () => null;

  // Same fail-closed reasoning as the live branch above: no `renderImpl` is
  // configured for this quick, no-DB smoke check either — a `render: true`
  // source dry-run from here surfaces traverse's typed `invalid-config`
  // FetchError, never a silent unrendered fetch.
  const results = await runTraversePipeline(sources, {
    provider,
    store,
    sink,
    mode: "live",
  });

  return NextResponse.json({
    results: results.map(toResponseResult),
  });
}
