/**
 * scrape-runner.ts — per-source error isolation for the scraper sweep.
 *
 * Incident (2026-06-15 onward): a single dead source URL (Denver Art
 * Museum, HTTP 404) threw out of `BaseScraper.run()`, propagated
 * uncaught through the scrape loop in scripts/scrape.ts, and reached the
 * top-level `main().catch()` handler as a "Fatal" error — killing the
 * entire weekly sweep even though the other source(s) were healthy.
 *
 * This module isolates each source: a failure to fetch/parse one source
 * is captured, logged, and recorded in the report so the sweep continues
 * with the remaining sources. The overall process only exits non-zero
 * when failures exceed a configurable threshold (see
 * `resolveFailureThreshold` / `summarizeReport`), so the sweep stays
 * visibly healthy-or-not without a single dead site blocking everything.
 */

import { BaseScraper } from "./scraper-base";
import { CampInput } from "./adapter";

export interface ScraperReportEntry {
  /** Human-readable scraper/source name (BaseScraper.scraperName) */
  scraper: string;
  /** Entry URL for the source (BaseScraper.entryUrl) */
  url: string;
  /** False if the scraper failed to fetch/parse its source entirely */
  ok: boolean;
  /** Number of camps extracted (0 if the source failed) */
  found: number;
  /** Number of camps successfully upserted to the DB (0 in dry-run) */
  upserted: number;
  /** Error messages: source-level fetch/parse errors and/or per-camp upsert errors */
  errors: string[];
  /** Extracted camps — not printed in the summary, useful for dry-run previews */
  camps: CampInput[];
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
      `[scrape-runner] Invalid SCRAPE_FAILURE_THRESHOLD="${envValue}" (expected a number in [0,1]) — falling back to ${DEFAULT_FAILURE_THRESHOLD_RATIO}`
    );
    return DEFAULT_FAILURE_THRESHOLD_RATIO;
  }
  return parsed;
}

/**
 * Runs a single scraper end-to-end (fetch + parse) and NEVER throws:
 * any network error, HTTP error (e.g. 404), timeout, or parse exception
 * is caught and recorded as a non-fatal failure for this source only.
 *
 * If `upsert` is provided, each extracted camp is upserted individually;
 * a failure to upsert one camp does not stop the others from upserting.
 */
export async function runScraperSafe(
  scraper: BaseScraper,
  upsert?: (camp: CampInput) => Promise<void>
): Promise<ScraperReportEntry> {
  // `ok` reflects whether fetching/parsing the *source itself* succeeded
  // (BaseScraper.run() no longer throws — see scraper-base.ts — but this
  // try/catch stays as a defense-in-depth net for any future override or
  // truly unexpected failure that bypasses run()'s own handling).
  let ok = true;
  let camps: CampInput[] = [];
  let sourceErrors: string[] = [];

  try {
    const result = await scraper.run();
    camps = result.camps;
    sourceErrors = [...result.errors];
    if (sourceErrors.length > 0) {
      // run() reported a fetch/HTTP/parse failure for this source.
      ok = false;
    }
  } catch (err) {
    ok = false;
    const message = err instanceof Error ? err.message : String(err);
    sourceErrors = [message];
  }

  if (!ok) {
    console.error(
      `[${scraper.scraperName}] Source failed (continuing sweep): ${sourceErrors.join("; ")}`
    );
  }

  const errors = [...sourceErrors];
  let upserted = 0;
  if (upsert) {
    for (const camp of camps) {
      try {
        await upsert(camp);
        upserted++;
      } catch (e) {
        // A per-camp upsert failure does not mark the *source* as failed —
        // the fetch/scrape succeeded, only one record's DB write failed.
        errors.push(`${camp.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return {
    scraper: scraper.scraperName,
    url: scraper.entryUrl,
    ok,
    found: camps.length,
    upserted,
    errors,
    camps,
  };
}

export interface ScrapeSummary {
  totalSources: number;
  succeededSources: number;
  failedSources: number;
  failureRatio: number;
  thresholdRatio: number;
  totalUpserted: number;
  totalErrors: number;
  /** True when the process should exit non-zero */
  shouldExitNonZero: boolean;
  reasonLine: string;
}

/**
 * Summarizes a scrape report and decides whether the overall run should
 * be treated as failed (non-zero exit). "Failed" here means the source's
 * fetch/parse step threw (`ok === false`) — NOT that it found zero camps
 * or had a handful of per-camp upsert errors.
 */
export function summarizeReport(
  report: ScraperReportEntry[],
  thresholdRatio: number = DEFAULT_FAILURE_THRESHOLD_RATIO
): ScrapeSummary {
  const totalSources = report.length;
  const failedSources = report.filter((r) => !r.ok).length;
  const succeededSources = totalSources - failedSources;
  const failureRatio = totalSources > 0 ? failedSources / totalSources : 0;
  const totalUpserted = report.reduce((s, r) => s + r.upserted, 0);
  const totalErrors = report.reduce((s, r) => s + r.errors.length, 0);

  const zeroSucceeded = totalSources > 0 && succeededSources === 0;
  const overThreshold = failureRatio > thresholdRatio;
  const shouldExitNonZero = zeroSucceeded || overThreshold;

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
    totalUpserted,
    totalErrors,
    shouldExitNonZero,
    reasonLine,
  };
}

/** Prints a human-readable per-source report + summary line to the console. */
export function printReport(report: ScraperReportEntry[], summary: ScrapeSummary): void {
  console.log("\n📊 Scrape Report:");
  console.log("─".repeat(60));
  for (const r of report) {
    const status = !r.ok ? "❌" : r.errors.length > 0 ? "⚠️" : "✅";
    const failedTag = !r.ok ? " — SOURCE FAILED" : "";
    console.log(`${status} ${r.scraper} (${r.url}): ${r.found} found, ${r.upserted} upserted${failedTag}`);
    r.errors.slice(0, 3).forEach((e) => console.log(`   ✗ ${e}`));
  }
  console.log("─".repeat(60));
  console.log(`\n${summary.reasonLine}`);
  console.log(`✅ Done: ${summary.totalUpserted} camps updated, ${summary.totalErrors} errors`);
}
