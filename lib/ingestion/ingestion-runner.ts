/**
 * ingestion-runner.ts — per-source failure isolation + threshold summary for
 * the ingestion sweep. Renamed from scrape-runner.ts as part of the traverse
 * full cutover (owner directive, 2026-07): the sweep no longer runs
 * CSS-selector `BaseScraper`s, it runs `runTraversePipelineForSource`
 * (traverse-pipeline.ts) — but the isolation + threshold DISCIPLINE this
 * module encodes is explicitly KEPT, unchanged, per the cutover directive:
 *
 * Incident (2026-06-15 onward): a single dead source URL (Denver Art
 * Museum, HTTP 404) threw out of the old `BaseScraper.run()`, propagated
 * uncaught through the scrape loop in scripts/scrape.ts, and reached the
 * top-level `main().catch()` handler as a "Fatal" error — killing the
 * entire weekly sweep even though the other source(s) were healthy.
 *
 * This module isolates each source: a failure to fetch/extract one source
 * is captured, logged, and recorded in the report so the sweep continues
 * with the remaining sources. The overall process only exits non-zero when
 * failures exceed a configurable threshold (see `resolveFailureThreshold` /
 * `summarizeReport`), so the sweep stays visibly healthy-or-not without a
 * single dead site blocking everything. `SCRAPE_FAILURE_THRESHOLD` (the env
 * var name) is unchanged so no deploy config needs updating.
 */

import type { TraversePipelineSourceResult } from "./traverse-pipeline";

export interface IngestionReportEntry {
  /** stable source key (IngestionSourceConfig.key). */
  source: string;
  /** entry URL for the source. */
  url: string;
  /** False if the source's fetch/extraction failed entirely. */
  ok: boolean;
  /** Number of items (camps/courses/programs) traverse grouped out of this source (0 if failed). */
  itemsFound: number;
  /** Number of items successfully routed to the review sink (0 in dry-run or on failure). */
  itemsRouted: number;
  /** Error messages: source-level fetch/extraction errors. */
  errors: string[];
  /**
   * Render telemetry (see lib/ingestion/render-fetch.ts) — present only for
   * a `render: true` source whose render completed (issue #41).
   */
  render?: { durationMs: number; usedNetworkidleFallback: boolean };
}

/** Adapt a pipeline result into a report entry for summarizeReport/printReport. */
export function toIngestionReportEntry(result: TraversePipelineSourceResult): IngestionReportEntry {
  const errors: string[] = [];
  if (result.fetchError) errors.push(`fetch: ${result.fetchError}`);
  if (result.extractionError) errors.push(`extract: ${result.extractionError}`);
  return {
    source: result.source,
    url: result.url,
    ok: result.ok,
    itemsFound: result.itemCount,
    itemsRouted: result.routedProposalIds.filter((id) => id !== null).length,
    errors,
    render: result.render,
  };
}

/**
 * Default failure threshold: fail the whole sweep only if MORE THAN 50% of
 * sources failed, or if literally zero sources succeeded. A single dead
 * source among a small registry (e.g. 1 of 2) sits at exactly 50% and will
 * NOT trip this threshold — it stays a visible warning, not a fatal error.
 *
 * Override via the SCRAPE_FAILURE_THRESHOLD env var (0..1, exclusive
 * fraction of sources allowed to fail before the run is considered bad).
 */
export const DEFAULT_FAILURE_THRESHOLD_RATIO = 0.5;

export function resolveFailureThreshold(envValue: string | undefined): number {
  if (envValue === undefined || envValue === "") return DEFAULT_FAILURE_THRESHOLD_RATIO;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[ingestion-runner] Invalid SCRAPE_FAILURE_THRESHOLD="${envValue}" (expected a number in [0,1]) — falling back to ${DEFAULT_FAILURE_THRESHOLD_RATIO}`
    );
    return DEFAULT_FAILURE_THRESHOLD_RATIO;
  }
  return parsed;
}

export interface IngestionSummary {
  totalSources: number;
  succeededSources: number;
  failedSources: number;
  failureRatio: number;
  thresholdRatio: number;
  totalItemsRouted: number;
  totalErrors: number;
  /** True when the process should exit non-zero */
  shouldExitNonZero: boolean;
  reasonLine: string;
  /** Number of `render: true` sources whose render completed this sweep. */
  renderedSources: number;
  /** Of `renderedSources`, how many fell back from networkidle to domcontentloaded. */
  renderNetworkidleFallbacks: number;
}

/**
 * Summarizes an ingestion report and decides whether the overall run should
 * be treated as failed (non-zero exit). "Failed" here means the source's
 * fetch/extraction step errored (`ok === false`) — NOT that it found zero
 * items or had zero fields routed.
 */
export function summarizeReport(
  report: IngestionReportEntry[],
  thresholdRatio: number = DEFAULT_FAILURE_THRESHOLD_RATIO
): IngestionSummary {
  const totalSources = report.length;
  const failedSources = report.filter((r) => !r.ok).length;
  const succeededSources = totalSources - failedSources;
  const failureRatio = totalSources > 0 ? failedSources / totalSources : 0;
  const totalItemsRouted = report.reduce((s, r) => s + r.itemsRouted, 0);
  const totalErrors = report.reduce((s, r) => s + r.errors.length, 0);

  const zeroSucceeded = totalSources > 0 && succeededSources === 0;
  const overThreshold = failureRatio > thresholdRatio;
  const shouldExitNonZero = zeroSucceeded || overThreshold;

  const renderedSources = report.filter((r) => r.render !== undefined).length;
  const renderNetworkidleFallbacks = report.filter((r) => r.render?.usedNetworkidleFallback).length;

  const reasonLine = shouldExitNonZero
    ? `${failedSources}/${totalSources} sources failed (${Math.round(failureRatio * 100)}%), ` +
      `exceeding the >${Math.round(thresholdRatio * 100)}% threshold` +
      `${zeroSucceeded ? " (zero sources succeeded)" : ""}.`
    : `${succeededSources}/${totalSources} sources succeeded, ${failedSources} failed ` +
      `(within the >${Math.round(thresholdRatio * 100)}% failure threshold).`;

  return {
    totalSources,
    succeededSources,
    failedSources,
    failureRatio,
    thresholdRatio,
    totalItemsRouted,
    totalErrors,
    shouldExitNonZero,
    reasonLine,
    renderedSources,
    renderNetworkidleFallbacks,
  };
}

/** Prints a human-readable per-source report + summary line to the console. */
export function printReport(report: IngestionReportEntry[], summary: IngestionSummary): void {
  console.log("\n📊 Ingestion Report:");
  console.log("─".repeat(60));
  for (const r of report) {
    const status = !r.ok ? "❌" : r.errors.length > 0 ? "⚠️" : "✅";
    const failedTag = !r.ok ? " — SOURCE FAILED" : "";
    const renderTag = r.render
      ? ` [rendered in ${r.render.durationMs}ms${
          r.render.usedNetworkidleFallback ? ", networkidle→domcontentloaded fallback" : ""
        }]`
      : "";
    console.log(`${status} ${r.source} (${r.url}): ${r.itemsFound} item(s) found, ${r.itemsRouted} routed${failedTag}${renderTag}`);
    r.errors.slice(0, 3).forEach((e) => console.log(`   ✗ ${e}`));
  }
  console.log("─".repeat(60));
  console.log(`\n${summary.reasonLine}`);
  if (summary.renderedSources > 0) {
    console.log(
      `🖥️  ${summary.renderedSources} source(s) rendered via headless Chromium` +
        `${summary.renderNetworkidleFallbacks > 0 ? ` (${summary.renderNetworkidleFallbacks} used the networkidle→domcontentloaded fallback)` : ""}.`
    );
  }
  console.log(`✅ Done: ${summary.totalItemsRouted} items routed to review, ${summary.totalErrors} errors`);
}
