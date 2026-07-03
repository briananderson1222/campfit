/**
 * test-ingestion-runner.ts — regression test for lib/ingestion/ingestion-runner.ts
 * (renamed from lib/ingestion/scrape-runner.ts as part of the traverse full
 * cutover, owner directive 2026-07). Successor to the threshold-behavior
 * coverage in the deleted scripts/test-scrape-error-handling.ts — that file's
 * BaseScraper-specific tests (BaseScraper.run() never throws, per-camp
 * upsert isolation) no longer apply now that CSS-selector scrapers are gone;
 * the STRUCTURAL discipline they protected (a single dead source never
 * kills the sweep; the >50% failure threshold policy) is preserved here,
 * retargeted at the traverse pipeline's report shape.
 *
 * Pipeline-level failure isolation (one source failing doesn't stop the
 * next) is covered in scripts/test-traverse-replay.ts, since exercising it
 * meaningfully needs the real fetch->extract->route plumbing.
 */

import assert from "node:assert/strict";
import {
  toIngestionReportEntry,
  summarizeReport,
  resolveFailureThreshold,
  DEFAULT_FAILURE_THRESHOLD_RATIO,
  type IngestionReportEntry,
} from "../lib/ingestion/ingestion-runner";
import type { TraversePipelineSourceResult } from "../lib/ingestion/traverse-pipeline";

// ─── toIngestionReportEntry ─────────────────────────────────────────────

function pipelineResult(overrides: Partial<TraversePipelineSourceResult> = {}): TraversePipelineSourceResult {
  return {
    source: "s",
    url: "https://s.test",
    ok: true,
    itemCount: 0,
    routedProposalIds: [],
    routedFieldCount: 0,
    snapshotRef: null,
    snapshotBodyHash: null,
    fetchError: null,
    extractionError: null,
    warnings: [],
    tokensUsed: null,
    model: null,
    latencyMs: 0,
    ...overrides,
  };
}

function testToIngestionReportEntry() {
  const healthy = toIngestionReportEntry(
    pipelineResult({ ok: true, itemCount: 3, routedProposalIds: ["p1", "p2", null] })
  );
  assert.equal(healthy.ok, true);
  assert.equal(healthy.itemsFound, 3);
  assert.equal(healthy.itemsRouted, 2, "only non-null routed proposal ids count as routed");
  assert.deepEqual(healthy.errors, []);

  const failed = toIngestionReportEntry(
    pipelineResult({ ok: false, fetchError: "timeout: took too long", extractionError: null })
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /timeout/);

  console.log("✓ toIngestionReportEntry adapts a pipeline result into a report entry");
}

// ─── Threshold behavior (ported from the deleted scrape-runner test) ────

function entry(ok: boolean, name = "s"): IngestionReportEntry {
  return { source: name, url: `https://${name}.test`, ok, itemsFound: ok ? 1 : 0, itemsRouted: ok ? 1 : 0, errors: ok ? [] : ["boom"] };
}

function testThresholdBehavior() {
  // Real-world incident shape: 2 sources registered, 1 (DAM) is dead.
  // Exactly 50% failure — must NOT trip the default >50% threshold.
  const oneOfTwoFailed = summarizeReport([entry(true, "avid4"), entry(false, "dam")]);
  assert.equal(oneOfTwoFailed.failureRatio, 0.5);
  assert.equal(oneOfTwoFailed.shouldExitNonZero, false, "a single dead source among 2 must not fail the sweep");

  // Zero successes must always fail, regardless of ratio math.
  const allFailed = summarizeReport([entry(false, "a"), entry(false, "b")]);
  assert.equal(allFailed.shouldExitNonZero, true, "zero successful sources must fail the sweep");

  // Majority failing (3 of 4 = 75% > 50%) must fail.
  const majorityFailed = summarizeReport([entry(true, "a"), entry(false, "b"), entry(false, "c"), entry(false, "d")]);
  assert.equal(majorityFailed.shouldExitNonZero, true, "a majority of sources failing must fail the sweep");

  // A custom, stricter threshold (0.2) should fail even on the 1-of-2 case.
  const strict = summarizeReport([entry(true, "avid4"), entry(false, "dam")], 0.2);
  assert.equal(strict.shouldExitNonZero, true, "a stricter threshold should fail on the same 1-of-2 failure");

  // Empty report (no sources matched --source filter) should not claim failure.
  const empty = summarizeReport([]);
  assert.equal(empty.shouldExitNonZero, false);

  console.log("✓ summarizeReport() threshold behavior matches the documented policy");
}

function testResolveFailureThreshold() {
  assert.equal(resolveFailureThreshold(undefined), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold(""), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold("0.2"), 0.2);
  assert.equal(resolveFailureThreshold("1"), 1);
  assert.equal(resolveFailureThreshold("0"), 0);
  assert.equal(resolveFailureThreshold("not-a-number"), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold("-1"), DEFAULT_FAILURE_THRESHOLD_RATIO);
  assert.equal(resolveFailureThreshold("2"), DEFAULT_FAILURE_THRESHOLD_RATIO);

  console.log("✓ resolveFailureThreshold() parses SCRAPE_FAILURE_THRESHOLD with sane fallback");
}

async function main() {
  testToIngestionReportEntry();
  testThresholdBehavior();
  testResolveFailureThreshold();
  console.log("\ningestion-runner verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
