/**
 * scrape.ts — Ingestion sweep runner (full traverse cutover, owner
 * directive 2026-07; converged onto the shared crawl-orchestration seam,
 * campfit#85 WS11 Slice 4 Wave 4).
 *
 * Runs every configured source (lib/ingestion/sources.ts) through the
 * traverse pipeline (lib/ingestion/traverse-pipeline.ts): fetch with
 * snapshot capture -> per-item schema-directed extraction -> route each
 * item to the review sink (createProposal). There is no more CSS-selector
 * scraper registry, no more TRAVERSE_INGESTION flag, and no more legacy
 * shadow run — traverse is the only ingestion pipeline.
 *
 * Live-mode `CrawlRun` bookkeeping (creation, live progress/campLog/
 * errorLog writes, final status derivation) goes through the ONE shared
 * orchestration seam, `runCrawlPipeline({ sources, ... })`
 * (lib/ingestion/crawl-pipeline.ts) — the same tracker the camp-path
 * re-crawl routes use (see that file's doc). This script no longer hand-
 * rolls its own `createCrawlRun`/`completeCrawlRun` pair, its own
 * `ensureAnchorCamp` anchor-camp upsert, or an unjoinable `campId: ""`
 * errorLog placeholder — all of that now lives once, in the shared seam
 * (`ensureAnchorCamp`/`sourceFailureCampId` in crawl-pipeline.ts).
 *
 * `--dry-run` intentionally stays OFF the seam: `runCrawlPipeline`'s
 * `sources` strategy always creates a real `CrawlRun` row (it has no dry-run
 * concept of its own), so a dry run — no DB write, no `CrawlRun`, extract-
 * only — still calls `traverse-pipeline.ts`'s lower-level
 * `runTraversePipeline` directly, exactly as before.
 *
 * Rendered-fetch wiring (campfit#53, spa-ingestion, AC1/AC2/AC7): this
 * script is the ONLY place in the whole codebase that constructs the real
 * Playwright `RenderImpl` (`lib/ingestion/render-fetch.ts`'s
 * `createCampfitRenderImpl`) and passes it as `fetchOptions.renderImpl` —
 * both the dry-run path (direct `runTraversePipeline` call) and the live
 * path (`runCrawlPipeline`'s new `CrawlOptions.fetchOptions` passthrough)
 * wire it in. This matches the feasibility finding: only
 * `.github/workflows/scrape.yml`'s GitHub Actions execution context
 * provisions headless Chromium (`npx playwright install --with-deps
 * chromium`) — every Vercel-route caller of the shared pipeline
 * deliberately leaves `renderImpl` unset (see those routes' own comments),
 * so a `render: true`/`requiresRender: true` source recrawled from a
 * Vercel route fails closed with traverse's typed `invalid-config`
 * `FetchError` instead of silently launching (or failing to launch) a
 * browser in an environment that can't support one.
 *
 * Usage:
 *   npx tsx scripts/scrape.ts                    # Run all sources
 *   npx tsx scripts/scrape.ts --dry-run           # Extract but don't write to DB
 *   npx tsx scripts/scrape.ts --source avid4      # Run a single source
 */

import type { Pool } from "pg";
import { INGESTION_SOURCES } from "@/lib/ingestion/sources";
import { slugify } from "@/lib/ingestion/slug";
import {
  runTraversePipeline,
  type TraverseProposalSink,
  type TraversePipelineSourceResult,
} from "@/lib/ingestion/traverse-pipeline";
import { createCampfitSnapshotStore } from "@/lib/ingestion/traverse-snapshot-store";
import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { runCrawlPipeline } from "@/lib/ingestion/crawl-pipeline";
import { getPool } from "@/lib/db";
import { DatumError } from "@kontourai/datum";
import { loadLocalEnv } from "./load-env";
import {
  toIngestionReportEntry,
  summarizeReport,
  printReport,
  resolveFailureThreshold,
} from "@/lib/ingestion/ingestion-runner";
import { closeRenderBrowser, tryCreateCampfitRenderImpl } from "@/lib/ingestion/render-fetch";

loadLocalEnv();

// ─── Per-item current-value lookup (live mode only) ───────────────────────
//
// Anchor-camp creation/reuse (`ensureAnchorCamp`) and proposal persistence
// now live inside `runCrawlPipeline`'s `sources` strategy
// (lib/ingestion/crawl-pipeline.ts) — this script only still needs to
// supply the scalar-diffing `currentByItemNames` resolver, which reads
// (never writes) an existing Camp's current field values by
// `slugify(itemName)`, mirroring the anchor camp's own slug convention.

const CURRENT_VALUE_COLUMNS =
  `name, description, category, "registrationStatus", "applicationUrl", "websiteUrl", city, neighborhood, address`;

/** Look up an existing Camp's current field values by `slugify(itemName)`, if any. */
async function lookupCurrentBySlug(pool: Pool, itemName: string): Promise<Record<string, unknown> | null> {
  const slug = slugify(itemName);
  if (!slug) return null;
  const { rows } = await pool.query(
    `SELECT id, ${CURRENT_VALUE_COLUMNS} FROM "Camp" WHERE slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

// ─── Main ─────────────────────────────────────────────────────────────────

export async function main() {
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

  // Resolved once up front (both dry-run and live) so a missing/invalid
  // extraction provider fails fast with a helpful message, before any DB
  // touch — `runCrawlPipeline`'s `sources` strategy also resolves its own
  // provider internally for the live path (a process-level resource, same
  // convention as the camp strategy), but that resolution failing mid-run
  // would otherwise surface as a generic per-source `CrawlRun` failure
  // instead of this script's existing fail-fast UX.
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

  let results: TraversePipelineSourceResult[];

  // Render impl for shell-detection fallback IF this context has safe browser
  // egress; else undefined and the sweep runs plain-fetch-only. Constructed
  // once and reused across the dry-run and live paths. (createCampfitRenderImpl
  // fails closed until safe browser egress lands — see render-fetch.ts /
  // campfit#117; a raw call would throw here and abort the whole sweep.)
  const renderImpl = tryCreateCampfitRenderImpl();
  if (!renderImpl) {
    console.log(
      "⚠️  Render fallback unavailable in this context (no safe browser egress) — plain fetch only. render:true sources will not render until safe browser egress lands.\n",
    );
  }

  if (dryRun) {
    // No DB, no CrawlRun — matches the pre-existing dry-run/no-op contract.
    // Bypasses the shared seam entirely: `runCrawlPipeline`'s `sources`
    // strategy always creates a real `CrawlRun` row, which a dry run must
    // never do.
    const store = createCampfitSnapshotStore();
    const noopSink: TraverseProposalSink = async () => null;

    results = await runTraversePipeline(sources, {
      provider,
      store,
      sink: noopSink,
      mode: "live-with-capture",
      currentByItemNames: () => new Map<string, Record<string, unknown>>(),
      fetchOptions: renderImpl ? { renderImpl } : undefined,
    });
  } else {
    // Live sweep — converged onto the shared orchestration seam
    // (campfit#85 Wave 4): `runCrawlPipeline` owns CrawlRun creation, the
    // per-item anchor-camp/proposal sink, and live progress/campLog/
    // errorLog writes through the same tracker the camp-path re-crawl
    // routes use. `onSourceResult` collects the same
    // `TraversePipelineSourceResult[]` this script always printed a report
    // from, since `runCrawlPipeline` itself returns only the `CrawlRun`.
    const pool = getPool();
    const collected: TraversePipelineSourceResult[] = [];

    await runCrawlPipeline({
      sources,
      triggeredBy: "scrape:traverse-pipeline",
      trigger: "SCHEDULED",
      currentByItemNames: async (_sourceKey, itemNames) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const name of itemNames) {
          const current = await lookupCurrentBySlug(pool, name);
          if (current) out.set(name, current);
        }
        return out;
      },
      onSourceResult: (result) => {
        collected.push(result);
      },
      // The GitHub Actions sweep is the only execution context where a
      // headless Chromium browser can actually launch (see the file doc) —
      // this is the one wiring point for the real renderImpl. Constructing
      // it unconditionally (even when no configured source has render:true
      // yet) is safe/cheap: renderPage()/the browser are lazily launched on
      // first actual render call (see render-fetch.ts's file doc), so a
      // sweep with zero rendered sources never launches a browser at all.
      fetchOptions: renderImpl ? { renderImpl } : undefined,
    });

    results = collected;
  }

  // Closes the shared headless-Chromium instance if any `render: true`
  // source launched one this sweep (see lib/ingestion/render-fetch.ts) — a
  // no-op when no source rendered. Must run before the summary/exit so a
  // lingering browser process never keeps the sweep alive.
  await closeRenderBrowser();

  const report = results.map(toIngestionReportEntry);
  const thresholdRatio = resolveFailureThreshold(process.env.SCRAPE_FAILURE_THRESHOLD);
  const summary = summarizeReport(report, thresholdRatio);
  printReport(report, summary);

  if (summary.shouldExitNonZero) {
    console.error(`\n❌ Ingestion sweep failed: ${summary.reasonLine}`);
    process.exit(1);
  }
}

// Only auto-run when executed directly as a script (`npx tsx
// scripts/scrape.ts`) — guarded so a test can import `main` and drive it
// with mocked module boundaries without an unwanted real run firing at
// import time (mirrors Node's `require.main === module` idiom for ESM).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
