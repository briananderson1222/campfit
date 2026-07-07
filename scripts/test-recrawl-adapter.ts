/**
 * test-recrawl-adapter.ts — smoke coverage for
 * `lib/ingestion/traverse-recrawl-adapter.ts` (traverse-recrawl-cutover
 * plan, Task 1.3 / AC5 / AC6 / AC7, Stop-short risk 5). No network, no API
 * key — mirrors `scripts/test-traverse-replay.ts`'s stub-provider /
 * in-memory-snapshot-store / injected-fetch convention (network-free, CI
 * safe).
 *
 * Asserts:
 *  1. A single-item page maps to the target camp unambiguously (Task 1.3
 *     acceptance (a)).
 *  2. A multi-item/shared-listing page matches by the KNOWN camp's own name
 *     among that page's items when exactly one matches (never a
 *     whole-DB/name-keyed guess — Stop-short risk 5).
 *  3. A multi-item page with zero/ambiguous name matches surfaces a clear
 *     "ambiguous" failure and proposes NOTHING — never silently updates the
 *     wrong camp (Task 1.3 acceptance (b), Stop-short risk 5).
 *  4. `computeDiff`'s 30-day/0.8-confidence suppression of a
 *     recently-approved field actually fires on the re-crawl path (AC6,
 *     Task 1.3 acceptance (c)) — and does NOT fire when the re-proposed
 *     confidence clears the suppression threshold, proving this isn't an
 *     accidental blanket block.
 *  5. Admin-authored site hints (`CrawlSiteHint` rows) reach the extraction
 *     provider's `fieldHints` (AC7).
 *  6. Traverse snapshot provenance (`snapshot.ref`/`snapshot.bodyHash`) is
 *     present on a successful recrawl result.
 *  7. The restored neighborhoods enum-constraint (Wave 2 gap (a) closure —
 *     `TraverseRecrawlOptions.neighborhoods`) reaches the extraction
 *     provider's `fieldHints` under the `items[].neighborhood` key, mirroring
 *     the retired `llm-provider.ts` buildPrompt's `nbhdRule` wording, and
 *     coexists with an admin site hint rather than replacing it.
 *
 * Five-call-site smoke coverage (Task 3.2, AC14): the plan's Task 3.2
 * describes exercising `runCrawlPipeline` end-to-end against the real dev
 * Postgres (`verify-admin-platform.ts`'s convention). This worktree has no
 * `.env.local`/`DATABASE_URL` (confirmed: `scripts/load-env.ts` finds no env
 * file here), so that approach is not runnable in this environment — per
 * explicit instruction this coverage stays network-free instead, in two
 * parts:
 *  8. A STRUCTURAL check that all five named re-crawl routes
 *     (`app/api/admin/camps/[campId]/crawl/route.ts`,
 *     `app/api/admin/providers/[providerId]/crawl/route.ts`,
 *     `app/api/admin/crawl/start/route.ts`,
 *     `app/api/admin/crawl/onboard-url/route.ts`,
 *     `app/api/admin/assistant/route.ts`) still import and call the ONE
 *     shared `runCrawlPipeline` choke point (AC1) — reading route source
 *     from disk, no DB/network involved.
 *  9. Adapter-level SCENARIO coverage for each route's distinct selection
 *     semantics (per the plan's "Per-route semantics table"), run directly
 *     against `runTraverseRecrawlForCamp` (network-free, stub provider):
 *     - `camps/[campId]/crawl` and `assistant`'s `trigger_camp_crawl`: a
 *       single known campId targeting its own page directly — covered by
 *       test 1 above (structurally identical call shape, per the plan's
 *       table: "zero route-level change expected" for the assistant route).
 *     - `providers/[providerId]/crawl` and `assistant`'s
 *       `trigger_provider_crawl`: bulk N-camps-for-one-provider sharing a
 *       domain — covered by test 2 above (a shared-listing page, matched by
 *       each camp's own name).
 *     - `crawl/start`'s `campIds` sweep: multiple UNRELATED camps/domains in
 *       one run, each isolated from the others' failures — test 10 below.
 *     - `crawl/onboard-url`'s trailing re-crawl of a just-created placeholder
 *       camp (no `fieldSources` history yet) — test 11 below.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { ExtractionProvider, ProviderExtractionOutput } from "@kontourai/traverse";
import { createInMemorySnapshotStore, type FetchLike } from "@kontourai/traverse/fetch";
import { runTraverseRecrawlForCamp } from "../lib/ingestion/traverse-recrawl-adapter";
import { createStubProvider, type StubProposalSpec } from "../tests/fixtures/traverse/stub-provider";
import type { Camp } from "../lib/types";

const FIXTURE_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "traverse"
);

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

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

/** A minimal-but-complete `Camp` fixture — only the fields each test cares about vary. */
function makeCamp(overrides: Partial<Camp> = {}): Camp {
  return {
    id: "camp-1",
    slug: "mountain-explorers-day-camp",
    name: "Mountain Explorers Day Camp",
    description: "",
    notes: null,
    campType: "SUMMER_DAY",
    category: "OTHER",
    campTypes: [],
    categories: [],
    state: null,
    zip: null,
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    applicationUrl: null,
    contactEmail: null,
    contactPhone: null,
    socialLinks: null,
    interestingDetails: null,
    city: "",
    region: null,
    communitySlug: "denver",
    displayName: "Mountain Explorers Day Camp",
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

// ─── 1. Single-item page targets the known camp unambiguously ────────────

async function testSingleItemPageTargetsKnownCamp() {
  const html = loadFixture("avid4-healthy.html");
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder, Colorado" },
  ];

  const result = await runTraverseRecrawlForCamp({
    campId: "camp-1",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ city: "" }),
    provider: createStubProvider(specs, { model: "stub-recrawl-single" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.equal(result.ok, true, "single-item page must succeed");
  assert.equal(result.itemCount, 1);
  assert.equal(result.matchedItemName, "Mountain Explorers Day Camp");
  assert.ok(result.proposedChanges["city"], "city populate must be proposed");
  assert.equal(result.proposedChanges["city"].mode, "populate");
  assert.ok(result.snapshot.ref, "snapshot ref must be present on a captured fetch");
  assert.ok(result.snapshot.bodyHash, "snapshot bodyHash must be present on a captured fetch");

  console.log("✓ single-item page targets the known camp directly, with snapshot provenance");
}

// ─── 2. Multi-item page matches by the KNOWN camp's own name ─────────────

async function testMultiItemPageMatchesByName() {
  const html = loadFixture("avid4-multi-item.html");
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[0].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[1].name", candidateValue: "Junior Rangers Day Camp", needle: "Junior Rangers Day Camp" },
    { fieldPath: "items[0].pricing[0].amount", candidateValue: 425, needle: "$425 per week" },
    { fieldPath: "items[1].pricing[0].amount", candidateValue: 450, needle: "$450 per week" },
  ];

  const result = await runTraverseRecrawlForCamp({
    campId: "camp-2",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Junior Rangers Day Camp",
    current: makeCamp({ id: "camp-2", name: "Junior Rangers Day Camp", slug: "junior-rangers-day-camp" }),
    provider: createStubProvider(specs, { model: "stub-recrawl-multi" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.equal(result.ok, true, "a multi-item page with exactly one name match must succeed");
  assert.equal(result.itemCount, 2);
  assert.equal(result.matchedItemName, "Junior Rangers Day Camp", "must match the KNOWN camp's own item, not the other one on the shared page");
  assert.ok(result.proposedChanges["pricing"], "pricing must be proposed from the matched item");
  assert.deepEqual(
    (result.proposedChanges["pricing"].new as { amount: number }[])[0].amount,
    450,
    "matched item's own price (450), never the OTHER item's (425)"
  );

  console.log("✓ multi-item/shared-listing page matches the known camp by its own name, never the sibling item's fields");
}

// ─── 3. Multi-item page with no/ambiguous name match refuses to guess ────

async function testMultiItemPageAmbiguousFailsLoud() {
  const html = loadFixture("avid4-multi-item.html");
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[0].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[1].name", candidateValue: "Junior Rangers Day Camp", needle: "Junior Rangers Day Camp" },
    { fieldPath: "items[0].pricing[0].amount", candidateValue: 425, needle: "$425 per week" },
  ];

  const result = await runTraverseRecrawlForCamp({
    campId: "camp-3",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Some Unrelated Camp Entirely",
    current: makeCamp({ id: "camp-3", name: "Some Unrelated Camp Entirely", slug: "some-unrelated-camp" }),
    provider: createStubProvider(specs, { model: "stub-recrawl-ambiguous" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.equal(result.ok, false, "zero name matches on a shared listing page must fail, not silently pick an item");
  assert.match(result.error ?? "", /^traverse-recrawl:ambiguous-multi-item:/);
  assert.deepEqual(result.proposedChanges, {}, "no proposal fields on an ambiguous match — never a wrong-camp write");
  assert.equal(result.matchedItemName, null);

  console.log("✓ multi-item page with no confident name match surfaces a loud ambiguous failure, proposes nothing");
}

// ─── 4. AC6: 30-day/0.8-confidence suppression actually fires ────────────

async function testSuppressionFires() {
  const html = loadFixture("avid4-healthy.html");
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

  // Low-confidence re-proposal (0.5) of a field approved 10 days ago must be
  // SUPPRESSED — this is the exact scenario re-crawling an already-reviewed
  // camp hits routinely.
  const lowConfSpecs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorer Day Camp (Typo)", needle: "Mountain Explorers Day Camp", confidence: 0.5 },
  ];
  const suppressed = await runTraverseRecrawlForCamp({
    campId: "camp-4",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-4" }),
    fieldSources: { name: { approvedAt: tenDaysAgo } },
    provider: createStubProvider(lowConfSpecs, { model: "stub-suppress" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });
  assert.equal(suppressed.ok, true);
  assert.ok(
    !("name" in suppressed.proposedChanges),
    "a low-confidence (<0.8) re-proposal of a field approved <30 days ago must be suppressed"
  );

  // Same scenario, but confidence clears the 0.8 suppression threshold — the
  // change MUST still be proposed (proves this isn't an accidental blanket
  // block on the field).
  const highConfSpecs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorer Day Camp (Renamed)", needle: "Mountain Explorers Day Camp", confidence: 0.95 },
  ];
  const notSuppressed = await runTraverseRecrawlForCamp({
    campId: "camp-4",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-4" }),
    fieldSources: { name: { approvedAt: tenDaysAgo } },
    provider: createStubProvider(highConfSpecs, { model: "stub-not-suppress" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });
  assert.equal(notSuppressed.ok, true);
  assert.ok(
    "name" in notSuppressed.proposedChanges,
    "a HIGH-confidence (>=0.8) re-proposal must still be proposed even within the 30-day suppression window"
  );
  assert.equal(notSuppressed.proposedChanges["name"].new, "Mountain Explorer Day Camp (Renamed)");

  console.log("✓ AC6: 30-day/0.8-confidence suppression of a recently-approved field fires on the re-crawl path, and does not over-suppress high-confidence changes");
}

// ─── 5. AC7: admin-authored site hints reach the provider's fieldHints ───

async function testSiteHintsReachProviderCall() {
  const html = loadFixture("avid4-healthy.html");
  let capturedFieldHints: Record<string, string> | undefined;

  const capturingProvider: ExtractionProvider = {
    name: "capturing-stub",
    async extract(input): Promise<ProviderExtractionOutput> {
      capturedFieldHints = input.fieldHints;
      return { proposals: [], raw: { response: "{}", model: "capturing-stub" } };
    },
  };

  const hintText = "Prices for this domain are listed in the FAQ accordion, not the pricing table.";
  const result = await runTraverseRecrawlForCamp({
    campId: "camp-5",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-5" }),
    siteHints: [hintText],
    provider: capturingProvider,
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.ok(capturedFieldHints, "the provider must receive a fieldHints object");
  const values = Object.values(capturedFieldHints ?? {});
  assert.ok(values.includes(hintText), "the admin-authored site hint text must reach the provider's fieldHints");
  // The static per-field hints (traverse-schema.ts's CAMP_FIELD_HINTS) must
  // still be present too — the site hint AUGMENTS, never replaces them.
  assert.ok(
    Object.keys(capturedFieldHints ?? {}).some((k) => k.startsWith("items[]")),
    "the static CAMP_FIELD_HINTS entries must still be present alongside the site hint"
  );
  // No proposals from an empty extraction result → a clean "0 items" failure, not a crash.
  assert.equal(result.ok, false);
  assert.equal(result.error, "traverse-recrawl:no-items: traverse extracted zero items from this page");

  console.log("✓ AC7: admin-authored CrawlSiteHint rows reach the extraction provider's fieldHints, merged with the static per-field hints");
}

// ─── 7. Wave 2 gap (a): neighborhoods enum-constraint reaches the provider ─

async function testNeighborhoodHintReachesProviderCall() {
  const html = loadFixture("avid4-healthy.html");
  let capturedFieldHints: Record<string, string> | undefined;

  const capturingProvider: ExtractionProvider = {
    name: "capturing-stub-neighborhoods",
    async extract(input): Promise<ProviderExtractionOutput> {
      capturedFieldHints = input.fieldHints;
      return { proposals: [], raw: { response: "{}", model: "capturing-stub-neighborhoods" } };
    },
  };

  const neighborhoods = ["Baker", "Highland", "RiNo"];
  const siteHintText = "Registration links are behind a 'Programs' tab, not the homepage nav.";

  const result = await runTraverseRecrawlForCamp({
    campId: "camp-6",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-6" }),
    siteHints: [siteHintText],
    neighborhoods,
    provider: capturingProvider,
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.ok(capturedFieldHints, "the provider must receive a fieldHints object");
  const neighborhoodHint = (capturedFieldHints ?? {})["items[].neighborhood"];
  assert.ok(neighborhoodHint, "a dedicated items[].neighborhood field hint must be present");
  assert.ok(
    neighborhoods.every((n) => neighborhoodHint!.includes(n)),
    "the neighborhood hint must list every known neighborhood name"
  );
  assert.match(
    neighborhoodHint!,
    /one of these known neighborhoods, or null if not found/,
    "must mirror the retired llm-provider.ts buildPrompt's nbhdRule wording"
  );
  // The admin site hint must still coexist alongside the neighborhood hint —
  // the neighborhoods seam augments extraFieldHints, it doesn't replace it.
  const values = Object.values(capturedFieldHints ?? {});
  assert.ok(values.includes(siteHintText), "an admin site hint passed alongside neighborhoods must still reach the provider");
  // No proposals from an empty extraction result → a clean "0 items" failure, not a crash.
  assert.equal(result.ok, false);
  assert.equal(result.error, "traverse-recrawl:no-items: traverse extracted zero items from this page");

  console.log("✓ Wave 2 gap (a): the restored neighborhoods enum-constraint reaches the provider's fieldHints under items[].neighborhood, alongside admin site hints");
}

// ─── 8. AC1: all five named re-crawl routes still funnel through the ONE
// shared runCrawlPipeline choke point (structural, no DB/network) ─────────

const ROOT_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const FIVE_CALL_SITE_ROUTES = [
  "app/api/admin/camps/[campId]/crawl/route.ts",
  "app/api/admin/providers/[providerId]/crawl/route.ts",
  "app/api/admin/crawl/start/route.ts",
  "app/api/admin/crawl/onboard-url/route.ts",
  "app/api/admin/assistant/route.ts",
] as const;

async function testAllFiveCallSitesInvokeSharedPipeline() {
  for (const relPath of FIVE_CALL_SITE_ROUTES) {
    const source = fs.readFileSync(path.join(ROOT_DIR, relPath), "utf8");
    assert.match(
      source,
      /import\s*{\s*runCrawlPipeline\s*}\s*from\s*['"]@\/lib\/ingestion\/crawl-pipeline['"]/,
      `${relPath} must import runCrawlPipeline from lib/ingestion/crawl-pipeline (AC1 shared choke point)`
    );
    assert.match(
      source,
      /runCrawlPipeline\s*\(/,
      `${relPath} must call runCrawlPipeline(...)`
    );
    // None of the five may call the retired per-camp extraction path directly.
    assert.doesNotMatch(
      source,
      /extractCampDataFromUrl|llm-extractor/,
      `${relPath} must not reference the retired hand-rolled extraction path directly`
    );
  }
  console.log(`✓ AC1: all ${FIVE_CALL_SITE_ROUTES.length} named re-crawl routes still funnel through the shared runCrawlPipeline choke point`);
}

// ─── 9. crawl/start's campIds sweep: multiple unrelated camps in one run,
// isolated from each other's outcome ───────────────────────────────────────

async function testCampIdsSweepIsolatesFailures() {
  const healthyHtml = loadFixture("avid4-healthy.html");
  const multiHtml = loadFixture("avid4-multi-item.html");

  // Camp A: a normal single-item page — succeeds.
  const campA = await runTraverseRecrawlForCamp({
    campId: "sweep-camp-a",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "sweep-camp-a", city: "" }),
    provider: createStubProvider(
      [
        { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
        { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder, Colorado" },
      ],
      { model: "stub-sweep-a" }
    ),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(healthyHtml), sleep: async () => {} },
    log: () => {},
  });

  // Camp B: an unrelated shared-listing page whose items don't match this
  // camp's own name — fails as ambiguous, in the SAME sweep run.
  const campB = await runTraverseRecrawlForCamp({
    campId: "sweep-camp-b",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Some Other Sweep Camp Entirely",
    current: makeCamp({ id: "sweep-camp-b", name: "Some Other Sweep Camp Entirely", slug: "some-other-sweep-camp" }),
    provider: createStubProvider(
      [
        { fieldPath: "items[0].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
        { fieldPath: "items[1].name", candidateValue: "Junior Rangers Day Camp", needle: "Junior Rangers Day Camp" },
      ],
      { model: "stub-sweep-b" }
    ),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(multiHtml), sleep: async () => {} },
    log: () => {},
  });

  assert.equal(campA.ok, true, "camp A must succeed independently of camp B's outcome");
  assert.ok(campA.proposedChanges["city"], "camp A's own city change must be proposed");
  assert.equal(campB.ok, false, "camp B must fail (ambiguous) independently of camp A's success");
  assert.deepEqual(campB.proposedChanges, {}, "camp B's failure must not leak any of camp A's proposed fields");
  assert.notEqual(campA.matchedItemName, campB.matchedItemName);

  console.log("✓ crawl/start's campIds sweep: multiple unrelated camps in one run succeed/fail independently, no cross-camp leakage");
}

// ─── 10. crawl/onboard-url's trailing re-crawl of a just-created camp ─────

async function testOnboardUrlTrailingRecrawlPopulatesPlaceholderCamp() {
  const html = loadFixture("avid4-healthy.html");
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder, Colorado" },
  ];

  // Mirrors onboard-url's shape: a brand-new Camp row just INSERTed with
  // dataConfidence='PLACEHOLDER' and no fieldSources history yet (nothing has
  // ever been approved for it), immediately re-crawled.
  const result = await runTraverseRecrawlForCamp({
    campId: "onboard-new-camp-1",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({
      id: "onboard-new-camp-1",
      dataConfidence: "PLACEHOLDER",
      city: "",
    }),
    fieldSources: undefined,
    provider: createStubProvider(specs, { model: "stub-onboard-trailing" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
    log: () => {},
  });

  assert.equal(result.ok, true, "the trailing re-crawl of a just-created placeholder camp must succeed");
  assert.ok(result.proposedChanges["city"], "a populate-mode proposal must be produced (no prior approval history to suppress against)");
  assert.equal(result.proposedChanges["city"].mode, "populate");

  console.log("✓ crawl/onboard-url's trailing re-crawl of a newly-created placeholder camp populates cleanly with no suppression history");
}

// ─── 11. AC6 (campfit#53 spa-ingestion): requiresRender fails closed ─────
//
// A Vercel-route recrawl (this adapter's ONLY execution context — see its
// file doc) of a Provider.requiresRender:true camp must surface a typed
// invalid-config FetchError, never a crash and never a silently-accepted
// empty-shell "success". No `fetchOptions.renderImpl` is configured here,
// mirroring every real Vercel route's `TraversePipelineDeps`/`CrawlOptions`
// today (crawl-pipeline.ts never sets one for the camp strategy).

async function testRequiresRenderFailsClosedWithNoRenderer() {
  const result = await runTraverseRecrawlForCamp({
    campId: "camp-requires-render-1",
    websiteUrl: "https://spa-provider.example/camp",
    campName: "SPA Provider Camp",
    current: makeCamp({ id: "camp-requires-render-1" }),
    requiresRender: true,
    provider: createStubProvider([], { model: "stub-requires-render" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    // Deliberately NO fetchOptions.renderImpl — mirrors every Vercel route.
    log: () => {},
  });

  assert.equal(result.ok, false, "a requiresRender camp recrawled with no renderImpl configured must fail (never a silent success)");
  assert.ok(result.error?.startsWith("invalid-config:"), `expected a typed invalid-config error, got: ${result.error}`);
  assert.equal(result.itemCount, 0, "no items were ever grouped — the fetch itself never happened");
  assert.equal(Object.keys(result.proposedChanges).length, 0, "no changes are ever proposed from a failed, unrendered fetch");

  console.log("✓ AC6: Provider.requiresRender with no renderImpl configured fails closed with a typed invalid-config error, never a crash or silent empty-shell success");
}

// ─── Run ────────────────────────────────────────────────────────────────

async function main() {
  await testSingleItemPageTargetsKnownCamp();
  await testMultiItemPageMatchesByName();
  await testMultiItemPageAmbiguousFailsLoud();
  await testSuppressionFires();
  await testSiteHintsReachProviderCall();
  await testNeighborhoodHintReachesProviderCall();
  await testAllFiveCallSitesInvokeSharedPipeline();
  await testCampIdsSweepIsolatesFailures();
  await testOnboardUrlTrailingRecrawlPopulatesPlaceholderCamp();
  await testRequiresRenderFailsClosedWithNoRenderer();
  console.log("\ntraverse recrawl adapter verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
