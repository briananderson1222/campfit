/**
 * test-traverse-cost-guards.ts — network-free coverage for the traverse
 * 0.8.0 adoption (campfit#71): the `totalTokensUsed` undercount fix,
 * `providerCalls` metric threading, the `maxProviderCalls`/`maxTotalTokens`
 * spend ceilings wired at the shared fetch+extract call
 * (`lib/ingestion/traverse-pipeline.ts`'s `fetchAndExtractWithCostGuards`),
 * and the warnings-surfacing fix from the campfit#71 code review (iteration
 * 2). No network, no API key — same stub-provider/in-memory-snapshot-store/
 * injected-fetch convention as scripts/test-traverse-replay.ts and
 * scripts/test-recrawl-adapter.ts.
 *
 * Asserts:
 *  1. `tokensUsed` is the SUM of every chunk's provider call
 *     (`ExtractionResult.totalTokensUsed`), not just the last chunk's
 *     `raw.tokensUsed` — the regression this campfit#71 fix closes.
 *  2. `providerCalls` threads end-to-end: `ExtractionResult.providerCalls`
 *     -> `TraverseRecrawlResult.providerCalls` ->
 *     `crawl-pipeline.ts`'s `toLegacyMetricsResult` shim ->
 *     `metrics-repository.ts`'s `buildExtractionMetricRows`, landing a
 *     `provider_calls` row alongside `tokens_used` with the same
 *     campId-only dims convention.
 *  3. A `maxProviderCalls: 1` override stops BOTH the sweep
 *     (`runTraversePipelineForSource`) and re-crawl
 *     (`runTraverseRecrawlForCamp`) paths after exactly one provider call,
 *     with traverse's ceiling-stop warning present on `result.warnings`, AND
 *     that warning now actually SURFACES on both public report/metrics
 *     shapes (`IngestionReportEntry.warnings` on the sweep path,
 *     `LLMExtractionResult.warnings` via `toLegacyMetricsResult` on the
 *     re-crawl path) — the code-review HIGH finding this iteration closes:
 *     a ceiling-triggered truncation is no longer silently invisible.
 *  4. {@link DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE} (raised to 40, matching
 *     traverse's own hard `maxChunks` cap) is a genuine PURE BACKSTOP: an
 *     un-ceilinged run over a page needing more than 40 chunks stops at
 *     exactly 40 via the chunker's OWN `maxChunks` truncation, never via an
 *     independent `maxProviderCalls`-ceiling stop — closing the code
 *     review's HIGH finding that the OLD default (20) silently truncated
 *     any 21-40-call page. A second, lower-level check (via the exported
 *     `fetchAndExtractWithCostGuards` shim directly, with `maxChunks`
 *     artificially raised) proves the constant's value is nonetheless a
 *     real, correctly-set ceiling that WOULD engage if `maxChunks` were
 *     ever raised above it.
 *  5. `maxTotalTokens: <low>` (with a stub whose `tokensUsed` is set per
 *     call) stops extraction early with traverse's token-ceiling warning —
 *     the code review's MEDIUM finding that this ceiling shared
 *     `maxProviderCalls`'s code path but had NO direct test of its own.
 *     Also proves the RAISED {@link DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE}
 *     (450_000) does not bind an ordinary run.
 *  6. Shim-vs-upstream equivalence: the same stubbed fixture run through
 *     BOTH the local `fetchAndExtractWithCostGuards` (no ceilings set) and
 *     the real `fetchAndExtract` from `@kontourai/traverse/fetch` produces
 *     the same result (excluding the one genuinely non-deterministic,
 *     non-injectable field, `extraction.extractedAt`) — a tripwire against
 *     future upstream `fetchAndExtract` composition drift the shim doesn't
 *     mirror (the code review's other MEDIUM finding).
 */

import assert from "node:assert/strict";
import {
  createInMemorySnapshotStore,
  fetchAndExtract,
  type FetchLike,
  type SourceConfig,
} from "@kontourai/traverse/fetch";
import {
  runTraversePipelineForSource,
  fetchAndExtractWithCostGuards,
  DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE,
  DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE,
} from "../lib/ingestion/traverse-pipeline";
import { runTraverseRecrawlForCamp } from "../lib/ingestion/traverse-recrawl-adapter";
import { toLegacyMetricsResult } from "../lib/ingestion/crawl-pipeline";
import { buildExtractionMetricRows } from "../lib/admin/metrics-repository";
import { toIngestionReportEntry } from "../lib/ingestion/ingestion-runner";
import { createStubProvider } from "../tests/fixtures/traverse/stub-provider";
import { CAMP_TARGET_SCHEMA, CAMP_FIELD_HINTS } from "../lib/ingestion/traverse-schema";
import type { Camp } from "../lib/types";

function makeFixtureFetch(html: string): FetchLike {
  return async (fetchUrl: string) => {
    const isRobots = fetchUrl.endsWith("/robots.txt");
    return {
      status: 200,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === "content-type" ? (isRobots ? "text/plain" : "text/html; charset=utf-8") : null,
      },
      text: async () => (isRobots ? "User-agent: *\nDisallow:" : html),
    };
  };
}

/** A minimal-but-complete `Camp` fixture, mirroring test-recrawl-adapter.ts's. */
function makeCamp(overrides: Partial<Camp> = {}): Camp {
  return {
    id: "camp-1",
    slug: "cost-guard-camp",
    name: "Cost Guard Camp",
    description: "",
    notes: null,
    campType: "SUMMER_DAY",
    category: "OTHER",
    campTypes: [],
    categories: [],
    state: null,
    zip: null,
    websiteUrl: "https://cost-guard.test/camp",
    applicationUrl: null,
    contactEmail: null,
    contactPhone: null,
    socialLinks: null,
    interestingDetails: null,
    city: "",
    region: null,
    communitySlug: "denver",
    displayName: "Cost Guard Camp",
    neighborhood: "",
    address: "",
    latitude: null,
    longitude: null,
    lunchIncluded: false,
    registrationOpenDate: null,
    registrationOpenTime: null,
    registrationCloseDate: null,
    registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER",
    lastVerifiedAt: null,
    sourceUrl: null,
    fieldSources: null,
    ageGroups: [],
    schedules: [],
    pricing: [],
    ...overrides,
  };
}

/**
 * A single huge `<p>` (no repeated same-signature siblings, so traverse's
 * chunker never detects a "card" list and always falls back to plain
 * character-window chunking of the whole page — see
 * `@kontourai/traverse`'s `chunk.ts`, `findRepeatedCards`/`MIN_CARDS`) —
 * long enough to split into multiple ~12_000-char (default `chunkSize`)
 * windows, so a stub provider call happens once per window.
 */
function buildLargeSingleBlockHtml(totalChars: number): string {
  const phrase = "Mountain adventure day camp program overview and daily schedule details. ";
  const filler = phrase.repeat(Math.ceil(totalChars / phrase.length)).slice(0, totalChars);
  return `<html><body><h1>Camp Overview</h1><p>${filler}</p></body></html>`;
}

// ─── 1. totalTokensUsed sums across every chunk's call ────────────────────

async function testTotalTokensUsedSumsAcrossChunks() {
  const html = buildLargeSingleBlockHtml(30_000);
  const provider = createStubProvider([], {
    model: "cost-guard-stub-tokens",
    // First call reports 100 tokens, every subsequent call reports 1 — the
    // pre-0.8.0 bug (reading `raw.tokensUsed` from only the LAST chunk)
    // would report "1" here; the fix must report the SUM.
    tokensUsed: (callIndex) => (callIndex === 0 ? 100 : 1),
  });

  const result = await runTraversePipelineForSource(
    { key: "cost-guard-tokens", name: "Cost Guard Tokens", url: "https://cost-guard.test/tokens" },
    {
      provider,
      store: createInMemorySnapshotStore(),
      sink: async () => null,
      mode: "live-with-capture",
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
      log: () => {},
    }
  );

  assert.equal(result.ok, true, "a large plain-text page must still extract successfully");
  assert.ok(
    result.providerCalls >= 2,
    `expected the 30k-char page to chunk into >=2 provider calls, got ${result.providerCalls}`
  );
  const expectedTotal = 100 + (result.providerCalls - 1) * 1;
  assert.equal(
    result.tokensUsed,
    expectedTotal,
    "tokensUsed must be the SUM across every chunk's call, not just the last chunk's raw.tokensUsed"
  );
  assert.notEqual(
    result.tokensUsed,
    1,
    "must not regress to reading only the LAST chunk's raw.tokensUsed (campfit#71's undercount bug)"
  );

  console.log(
    `✓ totalTokensUsed sums across ${result.providerCalls} chunk call(s) (${result.tokensUsed} tokens), not just the last chunk's raw.tokensUsed`
  );
}

// ─── 2. providerCalls threads through to the metrics-row shape ────────────

async function testProviderCallsRecordedInMetricsShape() {
  const html = buildLargeSingleBlockHtml(30_000);
  const provider = createStubProvider([], { model: "cost-guard-stub-metrics", tokensUsed: 50 });

  const result = await runTraverseRecrawlForCamp({
    campId: "cost-guard-camp",
    websiteUrl: "https://cost-guard.test/metrics",
    campName: "Cost Guard Camp",
    current: makeCamp(),
    provider,
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.ok(
    result.providerCalls >= 2,
    `expected the 30k-char page to chunk into >=2 provider calls, got ${result.providerCalls}`
  );
  assert.equal(
    result.tokensUsed,
    result.providerCalls * 50,
    "tokensUsed must be 50-per-call, summed across every chunk"
  );

  const legacy = toLegacyMetricsResult(result);
  assert.equal(legacy.providerCalls, result.providerCalls, "toLegacyMetricsResult must carry providerCalls through unchanged");
  assert.equal(legacy.tokensUsed, result.tokensUsed ?? 0);

  const rows = buildExtractionMetricRows({
    campId: "cost-guard-camp",
    siteHost: "cost-guard.test",
    result: legacy,
    changesFound: 0,
    durationMs: 123,
  });

  const providerCallsRow = rows.find((r) => r.name === "provider_calls");
  assert.ok(providerCallsRow, "a provider_calls metric row must be recorded alongside tokens_used");
  assert.equal(providerCallsRow!.value, result.providerCalls);
  assert.deepEqual(
    providerCallsRow!.dims,
    { campId: "cost-guard-camp" },
    "provider_calls must follow tokens_used's campId-only dims convention"
  );

  const tokensUsedRow = rows.find((r) => r.name === "tokens_used");
  assert.ok(tokensUsedRow, "the pre-existing tokens_used row must still be present");
  assert.equal(tokensUsedRow!.value, result.tokensUsed ?? 0);

  console.log(
    `✓ providerCalls (${result.providerCalls}) threads ExtractionResult -> TraverseRecrawlResult -> toLegacyMetricsResult -> a provider_calls CrawlMetric row, alongside tokens_used`
  );
}

// ─── 3. A maxProviderCalls ceiling stops both paths early, with the
// ceiling warning now actually SURFACING on both public report/metrics
// shapes (code review HIGH fix, iteration 2) ──────────────────────────────

async function testCeilingHitStopsEarlyAndWarningSurfaces() {
  const html = buildLargeSingleBlockHtml(30_000);
  const ceilingWarningPattern = /stopped after 1 provider call\(s\): maxProviderCalls \(1\) reached/;

  // ── Sweep path ──
  const sweepResult = await runTraversePipelineForSource(
    { key: "cost-guard-ceiling-sweep", name: "Cost Guard Ceiling Sweep", url: "https://cost-guard.test/ceiling-sweep" },
    {
      provider: createStubProvider([], { model: "cost-guard-stub-ceiling-sweep" }),
      store: createInMemorySnapshotStore(),
      sink: async () => null,
      mode: "live-with-capture",
      maxProviderCalls: 1,
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
      log: () => {},
    }
  );
  assert.equal(sweepResult.providerCalls, 1, "maxProviderCalls: 1 must stop the sweep path after exactly one provider call");
  assert.ok(
    sweepResult.warnings.some((w) => ceilingWarningPattern.test(w)),
    "the ceiling-stop warning must surface on TraversePipelineSourceResult.warnings"
  );
  // Code review HIGH fix (iteration 2): ingestion-runner.ts's
  // toIngestionReportEntry — the shape scripts/scrape.ts's printReport
  // actually prints to the console/CI log — now carries this warning
  // through on its own `warnings` field, so a ceiling-triggered truncation
  // is no longer silently dropped before it reaches the printed/persisted
  // report.
  const reportEntry = toIngestionReportEntry(sweepResult);
  assert.ok(
    reportEntry.warnings?.some((w) => ceilingWarningPattern.test(w)),
    "IngestionReportEntry.warnings must carry the ceiling-stop warning through from TraversePipelineSourceResult.warnings"
  );

  // ── Re-crawl path ──
  const recrawlResult = await runTraverseRecrawlForCamp({
    campId: "cost-guard-ceiling-camp",
    websiteUrl: "https://cost-guard.test/ceiling-recrawl",
    campName: "Cost Guard Ceiling Camp",
    current: makeCamp({ id: "cost-guard-ceiling-camp" }),
    provider: createStubProvider([], { model: "cost-guard-stub-ceiling-recrawl" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    maxProviderCalls: 1,
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });
  assert.equal(recrawlResult.providerCalls, 1, "maxProviderCalls: 1 must stop the re-crawl path after exactly one provider call");
  assert.ok(
    recrawlResult.warnings.some((w) => ceilingWarningPattern.test(w)),
    "the ceiling-stop warning must surface on TraverseRecrawlResult.warnings"
  );
  // Code review HIGH fix (iteration 2): toLegacyMetricsResult (what
  // recordExtractionMetrics actually reads) now carries `warnings` through
  // too — LLMExtractionResult.warnings is populated whenever the underlying
  // TraverseRecrawlResult had 1+ warnings, so this ceiling-stop warning is
  // no longer dropped at this adapter boundary either.
  const legacy = toLegacyMetricsResult(recrawlResult);
  assert.ok(
    legacy.warnings?.some((w) => ceilingWarningPattern.test(w)),
    "LLMExtractionResult.warnings (toLegacyMetricsResult's output) must carry the ceiling-stop warning through from TraverseRecrawlResult.warnings"
  );

  console.log(
    "✓ a maxProviderCalls ceiling stops both the sweep and re-crawl paths after exactly the configured call count, with the ceiling warning now surfacing on both IngestionReportEntry.warnings and LLMExtractionResult.warnings"
  );
}

// ─── 4. The raised default (40, matching traverse's own hard maxChunks
// cap) is a genuine PURE BACKSTOP: on a page needing more than 40 chunks, an
// un-ceilinged run stops at exactly 40 via the chunker's OWN maxChunks
// truncation — never via an independent maxProviderCalls-ceiling stop. This
// is the code review's HIGH-fix requirement in the two halves that make it
// verifiable: (a) end-to-end through the real campfit-facing seam
// (`TraversePipelineDeps` has no `maxChunks` field, so this codebase can
// never observe the ceiling firing on its own below 40 — proving it truly
// never binds a normal run), and (b) a lower-level check, via the exported
// `fetchAndExtractWithCostGuards` shim directly (which — unlike
// `TraversePipelineDeps` — DOES accept `maxChunks`), that the
// DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE value itself is a real, correctly-
// set ceiling that WOULD engage as independent protection if `maxChunks`
// were ever raised above it. ─────────────────────────────────────────────

async function testDefaultProviderCallCeilingIsAPureBackstop() {
  assert.ok(
    DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE >= 40,
    "DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE must be >= traverse's own hard maxChunks cap (40) so it never binds below the pre-existing ceiling"
  );

  // (a) End-to-end through TraversePipelineDeps, nothing overridden: a page
  // needing more than 40 chunks (chunkSize=12_000, overlap=200 -> ~11_800-char
  // step) must still stop at exactly 40 — via the CHUNKER's own maxChunks
  // truncation, not an independent maxProviderCalls stop.
  const html = buildLargeSingleBlockHtml((DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE + 5) * 11_800 + 12_000);

  const result = await runTraversePipelineForSource(
    {
      key: "cost-guard-default-ceiling",
      name: "Cost Guard Default Ceiling",
      url: "https://cost-guard.test/default-ceiling",
    },
    {
      provider: createStubProvider([], { model: "cost-guard-stub-default-ceiling" }),
      store: createInMemorySnapshotStore(),
      sink: async () => null,
      mode: "live-with-capture",
      // maxProviderCalls/maxTotalTokens deliberately NOT set.
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
      log: () => {},
    }
  );

  assert.equal(
    result.providerCalls,
    DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE,
    `an un-ceilinged run over a page needing more than ${DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE} chunks must still stop at exactly the hard maxChunks cap`
  );
  assert.ok(
    result.warnings.some((w) => /dropped \d+ chunks? beyond maxChunks/.test(w)),
    "the chunker's own maxChunks-truncation warning must be present (the thing that ACTUALLY stopped this run)"
  );
  assert.ok(
    !result.warnings.some((w) => /maxProviderCalls \(\d+\) reached/.test(w)),
    "the independent maxProviderCalls-ceiling warning must NOT fire — the raised default must never bind below the pre-existing 40-chunk hard cap (this is the code review's HIGH fix: the OLD default of 20 fired here instead, silently truncating a 21-40-call page)"
  );

  // (b) Lower-level check that DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE's value
  // is a real, correctly-set ceiling — call the shim directly (bypassing
  // TraversePipelineDeps entirely) with an ARTIFICIALLY raised `maxChunks`
  // (something `TraversePipelineDeps` never does, but `fetchAndExtractWithCostGuards`'s
  // own `FetchAndExtractOptions` supports) so the page can chunk into MORE
  // than the default ceiling — proving the ceiling WOULD engage as
  // independent protection if `maxChunks` itself were ever raised.
  const raisedMaxChunks = DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE + 10;
  const shimResult = await fetchAndExtractWithCostGuards(
    { id: "cost-guard-default-ceiling-shim", url: "https://cost-guard.test/default-ceiling-shim" },
    {
      targetSchema: CAMP_TARGET_SCHEMA,
      fieldHints: CAMP_FIELD_HINTS,
      provider: createStubProvider([], { model: "cost-guard-stub-default-ceiling-shim" }),
      store: createInMemorySnapshotStore(),
      mode: "live-with-capture",
      maxChunks: raisedMaxChunks,
      maxProviderCalls: DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE,
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    }
  );
  assert.ok(shimResult.extraction, "sanity: the shim must have extracted something to check providerCalls/warnings on");
  assert.equal(
    shimResult.extraction!.providerCalls,
    DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE,
    `with maxChunks artificially raised to ${raisedMaxChunks}, DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE (${DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE}) must independently stop the run at exactly that many calls`
  );
  assert.ok(
    shimResult.extraction!.warnings?.some((w) => w.includes(`maxProviderCalls (${DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE}) reached`)),
    "the maxProviderCalls-ceiling warning must fire once maxChunks is raised above the default — proving the ceiling is real, correctly-valued protection, not accidentally disabled"
  );

  console.log(
    `✓ DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE (${DEFAULT_MAX_PROVIDER_CALLS_PER_SOURCE}) is a pure backstop: it never binds a normal (<=40-chunk) run (stopped by the chunker's own maxChunks cap instead), but is a real, correctly-set ceiling that engages once maxChunks is raised above it`
  );
}

// ─── 5. maxTotalTokens: a low ceiling stops extraction early with the
// token-ceiling warning, AND the raised default doesn't bind a normal run
// (code review MEDIUM fix — this ceiling previously shared
// maxProviderCalls's code path with no direct test of its own) ───────────

async function testMaxTotalTokensCeiling() {
  // ~6 chunks' worth (chunkSize=12_000, overlap=200 -> ~11_800-char step) so
  // a low maxTotalTokens ceiling can trip well before the page's chunks are
  // exhausted naturally.
  const html = buildLargeSingleBlockHtml(60_000);

  // ── Low ceiling: stops early with the maxTotalTokens warning ──
  const lowCeilingResult = await runTraversePipelineForSource(
    { key: "cost-guard-tokens-ceiling", name: "Cost Guard Tokens Ceiling", url: "https://cost-guard.test/tokens-ceiling" },
    {
      provider: createStubProvider([], { model: "cost-guard-stub-tokens-ceiling", tokensUsed: 100 }),
      store: createInMemorySnapshotStore(),
      sink: async () => null,
      mode: "live-with-capture",
      maxTotalTokens: 250,
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
      log: () => {},
    }
  );
  assert.ok(
    lowCeilingResult.providerCalls < 6,
    `expected maxTotalTokens: 250 (100 tokens/call) to stop the run before all ~6 chunks were processed, got ${lowCeilingResult.providerCalls} calls`
  );
  assert.equal(
    lowCeilingResult.tokensUsed,
    lowCeilingResult.providerCalls * 100,
    "tokensUsed must be 100-per-call, summed across only the calls actually made before the ceiling stopped the run"
  );
  const tokenCeilingWarningPattern = /stopped after \d+ provider call\(s\): maxTotalTokens \(250\) reached/;
  assert.ok(
    lowCeilingResult.warnings.some((w) => tokenCeilingWarningPattern.test(w)),
    "the maxTotalTokens ceiling-stop warning must surface on TraversePipelineSourceResult.warnings"
  );
  // Same HIGH fix as test 3: this warning surfaces on the report shape too.
  const reportEntry = toIngestionReportEntry(lowCeilingResult);
  assert.ok(
    reportEntry.warnings?.some((w) => tokenCeilingWarningPattern.test(w)),
    "IngestionReportEntry.warnings must carry the maxTotalTokens ceiling-stop warning through"
  );

  // ── The raised default (450_000) must NOT bind an ordinary run: same
  // page, realistic per-call token usage, maxTotalTokens left UNSET ──
  const normalRunResult = await runTraversePipelineForSource(
    { key: "cost-guard-tokens-default", name: "Cost Guard Tokens Default", url: "https://cost-guard.test/tokens-default" },
    {
      provider: createStubProvider([], { model: "cost-guard-stub-tokens-default", tokensUsed: 500 }),
      store: createInMemorySnapshotStore(),
      sink: async () => null,
      mode: "live-with-capture",
      // maxTotalTokens deliberately NOT set — proves DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE
      // (450_000) doesn't truncate a page whose real total spend
      // (providerCalls * 500, well under 450_000 for a ~6-chunk page) is
      // nowhere near that backstop.
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
      log: () => {},
    }
  );
  assert.ok(normalRunResult.ok, "a normal-sized run must still complete successfully with the default maxTotalTokens backstop in place");
  assert.ok(
    normalRunResult.providerCalls >= 5,
    `expected the ~60k-char page to chunk into its natural (~6) call count, unaffected by DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE (${DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE}), got ${normalRunResult.providerCalls}`
  );
  assert.ok(
    !normalRunResult.warnings.some((w) => w.includes("maxTotalTokens")),
    `DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE (${DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE}) must not bind a normal run (total spend ${normalRunResult.tokensUsed} tokens)`
  );

  console.log(
    `✓ maxTotalTokens: 250 stops a run early (${lowCeilingResult.providerCalls} call(s), ${lowCeilingResult.tokensUsed} tokens) with the ceiling warning surfacing on the report shape; DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE (${DEFAULT_MAX_TOTAL_TOKENS_PER_SOURCE}) does not bind a normal ${normalRunResult.providerCalls}-call run (${normalRunResult.tokensUsed} tokens)`
  );
}

// ─── 6. Shim-vs-upstream equivalence: fetchAndExtractWithCostGuards vs the
// real @kontourai/traverse/fetch fetchAndExtract, same fixture, no ceilings
// set — a tripwire for future upstream composition drift the local shim
// wouldn't otherwise be checked against (code review MEDIUM fix) ─────────

async function testShimMatchesUpstreamFetchAndExtract() {
  const html = buildLargeSingleBlockHtml(15_000);
  // Injected deterministic clock/now so the two independent fetches produce
  // byte-identical `Snapshot.fetchedAt`/`sourceRef` — the only genuinely
  // non-deterministic field left after that is `ExtractionResult.extractedAt`
  // (extract()'s own `new Date().toISOString()` call, with no injectable
  // clock), which is stripped before comparing below.
  const deterministicClock = () => "2026-07-03T00:00:00.000Z";
  const buildConfig = (): SourceConfig => ({
    id: "cost-guard-equivalence",
    url: "https://cost-guard.test/equivalence",
    userAgent: "campfit-cost-guard-equivalence-test/1.0",
  });
  const buildProvider = () =>
    createStubProvider(
      [{ fieldPath: "items[].name", candidateValue: "Cost Guard Camp", needle: "Mountain adventure day camp" }],
      { model: "cost-guard-stub-equivalence", tokensUsed: 42 }
    );
  const buildOpts = () => ({
    targetSchema: CAMP_TARGET_SCHEMA,
    fieldHints: CAMP_FIELD_HINTS,
    provider: buildProvider(),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture" as const,
    fetchOptions: {
      fetch: makeFixtureFetch(html),
      sleep: async () => {},
      now: () => 0,
      clock: deterministicClock,
    },
  });

  const shimResult = await fetchAndExtractWithCostGuards(buildConfig(), buildOpts());
  const upstreamResult = await fetchAndExtract(buildConfig(), buildOpts());

  // Strip the one field that can legitimately differ between two
  // independent calls (no injectable clock inside extract() itself) before
  // comparing — everything else (fetch outcome, snapshot, sourceRef,
  // extraction proposals/warnings/providerCalls/totalTokensUsed/raw) must be
  // byte-identical between the shim and real upstream fetchAndExtract, since
  // neither call sets maxProviderCalls/maxTotalTokens here (the only fields
  // the shim adds beyond upstream's own FetchAndExtractOptions).
  function stripNonDeterministicFields(result: typeof shimResult) {
    const clone = JSON.parse(JSON.stringify(result));
    if (clone.extraction) delete clone.extraction.extractedAt;
    return clone;
  }

  assert.deepEqual(
    stripNonDeterministicFields(shimResult),
    stripNonDeterministicFields(upstreamResult),
    "fetchAndExtractWithCostGuards must produce a result structurally identical to the real @kontourai/traverse/fetch fetchAndExtract (excluding extraction.extractedAt) when no cost-guard ceilings are set"
  );
  assert.ok(upstreamResult.extraction, "sanity: the fixture must actually produce an extraction on both sides");

  console.log(
    "✓ fetchAndExtractWithCostGuards matches the real @kontourai/traverse/fetch fetchAndExtract byte-for-byte (excluding extractedAt) with no ceilings set — a tripwire for future upstream composition drift"
  );
}

// ─── Run ────────────────────────────────────────────────────────────────

async function main() {
  await testTotalTokensUsedSumsAcrossChunks();
  await testProviderCallsRecordedInMetricsShape();
  await testCeilingHitStopsEarlyAndWarningSurfaces();
  await testDefaultProviderCallCeilingIsAPureBackstop();
  await testMaxTotalTokensCeiling();
  await testShimMatchesUpstreamFetchAndExtract();
  console.log("\ntraverse cost-guard adoption (campfit#71) verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
