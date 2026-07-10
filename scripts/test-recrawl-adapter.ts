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
import { recordRecrawlFreshness } from "../lib/ingestion/recrawl-freshness";
import { computeDiff } from "../lib/ingestion/diff-engine";
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

// ─── campfit#77 conditional-GET fixtures ─────────────────────────────────
//
// A response-`headers.get()` shim mirroring `makeFixtureFetch`'s shape.
// `fetchSource` reads validators via `response.headers.get("etag")` /
// `"last-modified"` (lowercase), so keys are stored lowercased.
function hdrGet(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

/**
 * Captures what the injected fetch saw on the MAIN (non-robots) resource — the
 * request headers (to assert `If-None-Match`/`If-Modified-Since` were/weren't
 * sent) and how many times the response body was read (to prove a bodyless 304
 * transferred nothing).
 */
interface RecrawlFetchProbe {
  mainRequests: number;
  mainRequestHeaders: Record<string, string>[];
  bodyReads: number;
}

function newProbe(): RecrawlFetchProbe {
  return { mainRequests: 0, mainRequestHeaders: [], bodyReads: 0 };
}

/**
 * A validator-aware injected fetch. Serves `/robots.txt` allow-all, then for the
 * main resource:
 *  - mode `"200"`: always a fresh `200` carrying `etag`/`last-modified` + `html`.
 *  - mode `"304-when-validated"`: a bodyless `304` IFF the request carried the
 *    matching `If-None-Match` AND `If-Modified-Since` (a real conditional-GET
 *    hit); otherwise a fresh `200` (so a missing-validator bug surfaces as a body
 *    read instead of a silent 304). `text()` increments `probe.bodyReads` so a
 *    304 that never reads its body is provable.
 */
function makeValidatorFetch(
  html: string,
  etag: string,
  lastModified: string,
  mode: "200" | "304-when-validated",
  probe: RecrawlFetchProbe
): FetchLike {
  return (async (fetchUrl: string, init?: { headers?: Record<string, string> }) => {
    if (fetchUrl.endsWith("/robots.txt")) {
      return { status: 200, headers: hdrGet({ "content-type": "text/plain" }), text: async () => "User-agent: *\nDisallow:" };
    }
    const headers = init?.headers ?? {};
    probe.mainRequests++;
    probe.mainRequestHeaders.push({ ...headers });
    const validated = headers["If-None-Match"] === etag && headers["If-Modified-Since"] === lastModified;
    if (mode === "304-when-validated" && validated) {
      return {
        status: 304,
        headers: hdrGet({ "content-type": "text/html; charset=utf-8", etag, "last-modified": lastModified }),
        text: async () => {
          probe.bodyReads++;
          return "";
        },
      };
    }
    return {
      status: 200,
      headers: hdrGet({ "content-type": "text/html; charset=utf-8", etag, "last-modified": lastModified }),
      text: async () => {
        probe.bodyReads++;
        return html;
      },
    };
  }) as FetchLike;
}

/** A provider whose `extract()` counts calls then throws — proves, independently of telemetry, that extraction never runs on a 304. */
function makeThrowingProvider(counter: { calls: number }): ExtractionProvider {
  return {
    name: "throwing-on-304",
    async extract(): Promise<ProviderExtractionOutput> {
      counter.calls++;
      throw new Error("extract() must never be called on a 304 (campfit#77 AC1)");
    },
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

const PRICE_A = {
  id: "price-a",
  label: "Standard week",
  amount: 425,
  unit: "PER_WEEK" as const,
  durationWeeks: null,
  ageQualifier: null,
  discountNotes: null,
};

const PRICE_B = {
  id: "price-b",
  label: "Extended week",
  amount: 525,
  unit: "PER_WEEK" as const,
  durationWeeks: null,
  ageQualifier: null,
  discountNotes: null,
};

const PRICE_C = {
  id: "price-c",
  label: "Holiday week",
  amount: 475,
  unit: "PER_WEEK" as const,
  durationWeeks: null,
  ageQualifier: null,
  discountNotes: null,
};

// Traverse's assembled relation shape intentionally has no persistence id.
// campfit#109 owns reconciling this with stored relation identity in the
// canonical pipeline; these fixtures characterize today's production shape.
const EXTRACTED_PRICE_A = {
  label: PRICE_A.label,
  amount: PRICE_A.amount,
  unit: PRICE_A.unit,
  durationWeeks: PRICE_A.durationWeeks,
  ageQualifier: PRICE_A.ageQualifier,
  discountNotes: PRICE_A.discountNotes,
};

const EXTRACTED_PRICE_B = {
  label: PRICE_B.label,
  amount: PRICE_B.amount,
  unit: PRICE_B.unit,
  durationWeeks: PRICE_B.durationWeeks,
  ageQualifier: PRICE_B.ageQualifier,
  discountNotes: PRICE_B.discountNotes,
};

const FIXED_NOW = Date.parse("2000-01-01T00:00:00.000Z");
const SUPPRESSION_WINDOW_MS = 30 * 86_400_000;

function approvalTimestamp(offsetFromBoundaryMs: number): string {
  return new Date(FIXED_NOW - SUPPRESSION_WINDOW_MS + offsetFromBoundaryMs).toISOString();
}

function withFixedNow<T>(run: () => T): T {
  const originalDateNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return run();
  } finally {
    Date.now = originalDateNow;
  }
}

async function withFixedNowAsync<T>(run: () => Promise<T>): Promise<T> {
  const originalDateNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return await run();
  } finally {
    Date.now = originalDateNow;
  }
}

// ─── campfit#108 Wave 0: direct computeDiff behavior lock ───────────────

function testComputeDiffBehaviorTable() {
  const sourceUrl = "https://example.test/camps";
  const excerpt = "Weekly camp prices";

  const strictSuperset = computeDiff(
    makeCamp({ pricing: [PRICE_A] }),
    { pricing: [PRICE_A, PRICE_B] },
    { pricing: 0.91 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.deepEqual(strictSuperset, {
    pricing: {
      old: [PRICE_A],
      new: [PRICE_A, PRICE_B],
      confidence: 0.91,
      mode: "add_items",
      excerpt,
      sourceUrl,
    },
  });

  const replacement = computeDiff(
    makeCamp({ pricing: [PRICE_A, PRICE_B] }),
    { pricing: [PRICE_A, PRICE_C] },
    { pricing: 0.92 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.deepEqual(replacement, {
    pricing: {
      old: [PRICE_A, PRICE_B],
      new: [PRICE_A, PRICE_C],
      confidence: 0.92,
      mode: "update",
      excerpt,
      sourceUrl,
    },
  });

  const populate = computeDiff(
    makeCamp({ pricing: [] }),
    { pricing: [PRICE_A] },
    { pricing: 0.93 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.deepEqual(populate, {
    pricing: {
      old: [],
      new: [PRICE_A],
      confidence: 0.93,
      mode: "populate",
      excerpt,
      sourceUrl,
    },
  });

  // The canonical crawl pipeline currently clears stored relations before
  // diffing. campfit#109 owns making real current relations reachable.
  const productionEmptyCurrent = computeDiff(
    makeCamp({ pricing: [] }),
    { pricing: [EXTRACTED_PRICE_A] },
    { pricing: 0.93 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.equal(
    productionEmptyCurrent.pricing?.mode,
    "populate",
    "canonical empty-current relation shape must characterize today's populate behavior (campfit#109)"
  );

  // If a caller supplies stored id-bearing relations, Traverse's id-less
  // extracted shape does not retain the same whole-object identity today.
  // campfit#109 owns the design change; #108 pins the honest behavior.
  const productionIdentityMismatch = computeDiff(
    makeCamp({ pricing: [PRICE_A] }),
    { pricing: [EXTRACTED_PRICE_A, EXTRACTED_PRICE_B] },
    { pricing: 0.93 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.equal(
    productionIdentityMismatch.pricing?.mode,
    "update",
    "id-bearing current vs id-less extracted [A] -> [A, B] must characterize today's update behavior (campfit#109)"
  );

  assert.deepEqual(
    computeDiff(
      makeCamp({ pricing: [PRICE_A, PRICE_B] }),
      { pricing: [PRICE_B, PRICE_A] },
      { pricing: 0.94 },
      { pricing: excerpt },
      {},
      sourceUrl
    ),
    {},
    "pure outer-array reorder must produce no proposal"
  );

  const exactSerialized = computeDiff(
    makeCamp({ name: "Old name", campTypes: ["SUMMER_DAY"], pricing: [PRICE_A] }),
    { name: "New name", campTypes: ["SUMMER_DAY", "SCHOOL_BREAK"], pricing: [PRICE_A, PRICE_B] },
    { name: 0.81, campTypes: 0.82, pricing: 0.83 },
    { name: "Camp title", campTypes: "Program types", pricing: excerpt },
    {},
    sourceUrl
  );
  assert.equal(
    JSON.stringify(exactSerialized),
    '{"name":{"old":"Old name","new":"New name","confidence":0.81,"mode":"update","excerpt":"Camp title","sourceUrl":"https://example.test/camps"},"campTypes":{"old":["SUMMER_DAY"],"new":["SUMMER_DAY","SCHOOL_BREAK"],"confidence":0.82,"mode":"update","excerpt":"Program types","sourceUrl":"https://example.test/camps"},"pricing":{"old":[{"id":"price-a","label":"Standard week","amount":425,"unit":"PER_WEEK","durationWeeks":null,"ageQualifier":null,"discountNotes":null}],"new":[{"id":"price-a","label":"Standard week","amount":425,"unit":"PER_WEEK","durationWeeks":null,"ageQualifier":null,"discountNotes":null},{"id":"price-b","label":"Extended week","amount":525,"unit":"PER_WEEK","durationWeeks":null,"ageQualifier":null,"discountNotes":null}],"confidence":0.83,"mode":"add_items","excerpt":"Weekly camp prices","sourceUrl":"https://example.test/camps"}}',
    "representative multi-field recrawl output must preserve property presence and order byte-for-byte"
  );

  assert.deepEqual(
    computeDiff(makeCamp({ city: "Denver" }), { city: "Boulder" }, { city: 0.299999 }),
    {},
    "confidence just below 0.3 must be omitted"
  );
  assert.deepEqual(
    computeDiff(makeCamp({ city: "Denver" }), { city: "Boulder" }, { city: 0.3 }),
    { city: { old: "Denver", new: "Boulder", confidence: 0.3, mode: "update" } },
    "confidence exactly 0.3 must remain eligible and missing provenance must remain omitted"
  );

  const justInsideSuppressionWindow = { city: { approvedAt: approvalTimestamp(1) } };
  const justOutsideSuppressionWindow = { city: { approvedAt: approvalTimestamp(-1) } };
  withFixedNow(() => {
    assert.deepEqual(
      computeDiff(makeCamp({ city: "Denver" }), { city: "Boulder" }, { city: 0.79 }, {}, justInsideSuppressionWindow),
      {},
      "a low-confidence scalar approved just inside 30 days must be suppressed"
    );
    assert.deepEqual(
      computeDiff(makeCamp({ city: "Denver" }), { city: "Boulder" }, { city: 0.79 }, {}, justOutsideSuppressionWindow),
      { city: { old: "Denver", new: "Boulder", confidence: 0.79, mode: "update" } },
      "a low-confidence scalar approved just outside 30 days must surface"
    );
    assert.deepEqual(
      computeDiff(makeCamp({ city: "Denver" }), { city: "Boulder" }, { city: 0.8 }, {}, justInsideSuppressionWindow),
      { city: { old: "Denver", new: "Boulder", confidence: 0.8, mode: "update" } },
      "a recently approved field at confidence exactly 0.8 must surface"
    );
  });

  console.log("✓ computeDiff characterization: strict superset/replacement/populate/reorder, exact serialization, confidence/suppression boundaries, and provenance omission");

  // Keep the pre-fix RED assertion last: every characterization above must
  // pass before the baseline fails on the one known behavior defect.
  const duplicateOnly = computeDiff(
    makeCamp({ pricing: [PRICE_A] }),
    { pricing: [PRICE_A, PRICE_A] },
    { pricing: 0.95 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.deepEqual(duplicateOnly, {
    pricing: {
      old: [PRICE_A],
      new: [PRICE_A, PRICE_A],
      confidence: 0.95,
      mode: "update",
      excerpt,
      sourceUrl,
    },
  }, "duplicate-only growth must be update because it contains no novel candidate");

  const duplicateCurrentNotRetained = computeDiff(
    makeCamp({ pricing: [PRICE_A, PRICE_A] }),
    { pricing: [PRICE_A, PRICE_B, PRICE_C] },
    { pricing: 0.96 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.equal(
    duplicateCurrentNotRetained.pricing?.mode,
    "update",
    "[A, A] -> [A, B, C] must be update because candidate multiplicity does not retain both A occurrences"
  );

  const duplicateCurrentRetained = computeDiff(
    makeCamp({ pricing: [PRICE_A, PRICE_A] }),
    { pricing: [PRICE_A, PRICE_A, PRICE_B] },
    { pricing: 0.97 },
    { pricing: excerpt },
    {},
    sourceUrl
  );
  assert.equal(
    duplicateCurrentRetained.pricing?.mode,
    "add_items",
    "[A, A] -> [A, A, B] must be add_items because both A occurrences are retained and B is novel"
  );

  console.log("✓ accepted deltas: duplicate-only [A] -> [A, A] is update; duplicate-current retention uses multiset counts; genuine additions remain add_items");
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
  return withFixedNowAsync(async () => {
    const html = loadFixture("avid4-healthy.html");
    const justInsideSuppressionWindow = approvalTimestamp(1);

    // Low-confidence re-proposal (0.5) of a field approved just inside 30 days must be
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
      fieldSources: { name: { approvedAt: justInsideSuppressionWindow } },
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
      fieldSources: { name: { approvedAt: justInsideSuppressionWindow } },
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
  });
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

// ─── 12. campfit#77 AC1: conditional GET — 304 skips extraction, records
// crawl freshness, zero provider calls ────────────────────────────────────

async function testConditionalGet304SkipsExtractionAndRefreshesFreshness() {
  const html = loadFixture("avid4-healthy.html");
  const etag = '"v1-abc"';
  const lastModified = "Wed, 01 Jan 2025 00:00:00 GMT";
  const store = createInMemorySnapshotStore();

  // Run 1 — seed: a fresh 200 that captures a snapshot WITH validators
  // (etag/last-modified). An empty store means no conditional GET is attempted,
  // so this is a plain first fetch.
  const seedProbe = newProbe();
  const seedSpecs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder, Colorado" },
  ];
  const seed = await runTraverseRecrawlForCamp({
    campId: "camp-304",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-304", city: "" }),
    provider: createStubProvider(seedSpecs, { model: "stub-304-seed" }),
    store,
    mode: "live-with-capture",
    fetchOptions: { fetch: makeValidatorFetch(html, etag, lastModified, "200", seedProbe), sleep: async () => {} },
    log: () => {},
  });
  assert.equal(seed.ok, true, "seed run must succeed and capture a snapshot with validators");
  assert.equal(seed.notModified ?? false, false, "the seeding 200 is not a 304");
  assert.ok(seed.snapshot.bodyHash, "seed run must capture a snapshot bodyHash");
  assert.ok(
    !("If-None-Match" in (seedProbe.mainRequestHeaders[0] ?? {})),
    "the first fetch (empty store) must send no validators"
  );

  // Run 2 — the store now holds a validated prior: a conditional GET must send
  // If-None-Match/If-Modified-Since and receive a bodyless 304. The provider
  // throws-on-call so any accidental extraction is caught independently of
  // telemetry.
  const probe = newProbe();
  const providerCounter = { calls: 0 };
  const result = await runTraverseRecrawlForCamp({
    campId: "camp-304",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-304", city: "" }),
    provider: makeThrowingProvider(providerCounter),
    store,
    mode: "live-with-capture",
    fetchOptions: { fetch: makeValidatorFetch(html, etag, lastModified, "304-when-validated", probe), sleep: async () => {} },
    log: () => {},
  });

  const req = probe.mainRequestHeaders[0] ?? {};
  assert.equal(req["If-None-Match"], etag, "the recrawl must send If-None-Match from the prior snapshot's etag");
  assert.equal(req["If-Modified-Since"], lastModified, "the recrawl must send If-Modified-Since from the prior snapshot's last-modified");
  assert.equal(probe.bodyReads, 0, "a bodyless 304 must never have its body read (zero body transfer)");
  assert.equal(providerCounter.calls, 0, "extract() must never be called on a 304 (throwing-provider counter proves it)");
  assert.equal(result.ok, true, "a 304 is a successful freshness check");
  assert.equal(result.notModified, true, "a 304 must surface notModified: true");
  assert.equal(result.providerCalls, 0, "zero provider calls on a 304 (telemetry)");
  assert.equal(result.tokensUsed, null, "no tokens used on a 304 — extraction never ran");
  assert.deepEqual(result.proposedChanges, {}, "a 304 proposes nothing");
  assert.equal(result.itemCount, 0, "a 304 selects/groups no items");
  assert.equal(result.matchedItemName, null, "a 304 matches no item");
  assert.ok(result.snapshot.bodyHash, "the re-served prior snapshot's provenance is present");
  assert.equal(result.snapshot.bodyHash, seed.snapshot.bodyHash, "the 304 re-serves the byte-identical prior snapshot");

  // Freshness seam: recordRecrawlFreshness writes ONLY lastCrawledAt (crawl
  // freshness), never lastVerifiedAt/dataConfidence — asserted directly against
  // a fake pool with a fixed clock (AC1 amendment, issue #77).
  const checkedAt = new Date("2026-07-10T12:00:00.000Z");
  const queries: { text: string; values: unknown[] }[] = [];
  const fakePool = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rowCount: 1 };
    },
  };
  const updated = await recordRecrawlFreshness(fakePool as never, { campId: "camp-304", checkedAt });
  assert.equal(updated, true, "a present camp row reports updated: true");
  assert.equal(queries.length, 1, "exactly one UPDATE is issued");
  assert.match(queries[0].text, /UPDATE "Camp" SET "lastCrawledAt" = \$1 WHERE id = \$2/, "writes lastCrawledAt for the exact camp id, parameterized");
  assert.doesNotMatch(queries[0].text, /lastVerifiedAt|dataConfidence/, "must NEVER touch lastVerifiedAt/dataConfidence — verification authority is untouched (AC1 amendment)");
  assert.deepEqual(queries[0].values, [checkedAt, "camp-304"], "exact checkedAt + campId params");
  const missingPool = { query: async () => ({ rowCount: 0 }) };
  assert.equal(
    await recordRecrawlFreshness(missingPool as never, { campId: "gone", checkedAt }),
    false,
    "a missing/deleted camp row is observable as updated: false"
  );

  console.log("✓ campfit#77 AC1: an unchanged page (304) sends validators, transfers no body, runs zero provider calls, skips extraction/selection/diff/proposal, and records crawl freshness (lastCrawledAt only)");
}

// ─── 13. campfit#77 AC2: a changed page's fresh 200 behaves exactly as today ─

async function testConditionalGet200PreservesChangedPageBehavior() {
  const html = loadFixture("avid4-healthy.html");
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder, Colorado" },
  ];

  // Baseline: the pre-#77 plain path. An EMPTY store means no conditional GET is
  // attempted even though the adapter now opts in — byte-for-byte the old fetch.
  const baselineProbe = newProbe();
  const baseline = await runTraverseRecrawlForCamp({
    campId: "camp-200",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-200", city: "" }),
    provider: createStubProvider(specs, { model: "stub-200-baseline" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeValidatorFetch(html, '"old"', "Wed, 01 Jan 2025 00:00:00 GMT", "200", baselineProbe), sleep: async () => {} },
    log: () => {},
  });
  assert.equal(baseline.ok, true, "baseline plain-path recrawl succeeds");
  assert.ok(baseline.proposedChanges["city"], "baseline produces the city populate");

  // Revalidating changed-200: seed a prior (old etag/last-modified), then serve a
  // fresh 200 with a NEW etag. Validators ARE sent, but a changed 200 does NOT
  // short-circuit — full fetch -> extract -> computeDiff runs, with output
  // identical to the baseline plain path.
  const store = createInMemorySnapshotStore();
  const seedProbe = newProbe();
  await runTraverseRecrawlForCamp({
    campId: "camp-200",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-200", city: "" }),
    provider: createStubProvider(specs, { model: "stub-200-seed" }),
    store,
    mode: "live-with-capture",
    fetchOptions: { fetch: makeValidatorFetch(html, '"old"', "Wed, 01 Jan 2025 00:00:00 GMT", "200", seedProbe), sleep: async () => {} },
    log: () => {},
  });

  const probe = newProbe();
  const providerCounter = { calls: 0 };
  const changedStub = createStubProvider(specs, { model: "stub-200-changed" });
  const countingProvider: ExtractionProvider = {
    name: "counting-changed-200",
    async extract(input): Promise<ProviderExtractionOutput> {
      providerCounter.calls++;
      return changedStub.extract(input);
    },
  };
  const changed = await runTraverseRecrawlForCamp({
    campId: "camp-200",
    websiteUrl: "https://avid4.com/day-camps/colorado/",
    campName: "Mountain Explorers Day Camp",
    current: makeCamp({ id: "camp-200", city: "" }),
    provider: countingProvider,
    store,
    mode: "live-with-capture",
    // A NEW etag => the server treats the page as changed, returns a fresh 200.
    fetchOptions: { fetch: makeValidatorFetch(html, '"new"', "Thu, 02 Jan 2025 00:00:00 GMT", "200", probe), sleep: async () => {} },
    log: () => {},
  });

  const req = probe.mainRequestHeaders[0] ?? {};
  assert.equal(req["If-None-Match"], '"old"', "a changed-page recrawl still SENDS the prior validators (conditional GET attempted)");
  assert.equal(changed.notModified ?? false, false, "a fresh 200 is not notModified");
  assert.ok(providerCounter.calls > 0, "a changed 200 calls the provider (full extraction ran)");
  assert.ok(probe.bodyReads > 0, "a changed 200 reads the response body");
  assert.deepEqual(
    changed.proposedChanges,
    baseline.proposedChanges,
    "a changed 200 produces byte-identical proposedChanges to the pre-#77 plain path (AC2 regression lock)"
  );
  assert.equal(changed.matchedItemName, baseline.matchedItemName, "the matched item is unchanged from the plain path");
  // Note: duplicate-only array growth => `update` remains locked by #108's
  // testComputeDiffBehaviorTable above (unchanged, not re-asserted here).

  console.log("✓ campfit#77 AC2: a changed page's fresh 200 still sends validators, reads the body, runs full extraction, and produces output identical to the pre-#77 plain path");
}

// ─── 14. campfit#77 DOD-RENDER: rendered recrawls never use HTTP validators ─

async function testConditionalGetDoesNotApplyToRenderedRecrawl() {
  const html = loadFixture("avid4-healthy.html");
  const etag = '"render-prior"';
  const lastModified = "Wed, 01 Jan 2025 00:00:00 GMT";
  const store = createInMemorySnapshotStore();

  // Seed a validated prior snapshot for this camp, so we can prove a rendered
  // recrawl neither sends nor reuses those HTTP validators.
  const seedProbe = newProbe();
  await runTraverseRecrawlForCamp({
    campId: "camp-render",
    websiteUrl: "https://spa-provider.example/camp",
    campName: "SPA Provider Camp",
    current: makeCamp({ id: "camp-render", name: "SPA Provider Camp", slug: "spa-provider-camp" }),
    provider: createStubProvider(
      [{ fieldPath: "items[].name", candidateValue: "SPA Provider Camp", needle: "Mountain Explorers Day Camp" }],
      { model: "stub-render-seed" }
    ),
    store,
    mode: "live-with-capture",
    fetchOptions: { fetch: makeValidatorFetch(html, etag, lastModified, "200", seedProbe), sleep: async () => {} },
    log: () => {},
  });

  // Recrawl the SAME camp as requiresRender:true with NO renderImpl — every
  // Vercel route's real configuration. A validator probe is injected; the render
  // path must never issue an HTTP conditional GET with it.
  const probe = newProbe();
  const result = await runTraverseRecrawlForCamp({
    campId: "camp-render",
    websiteUrl: "https://spa-provider.example/camp",
    campName: "SPA Provider Camp",
    current: makeCamp({ id: "camp-render", name: "SPA Provider Camp", slug: "spa-provider-camp" }),
    requiresRender: true,
    provider: createStubProvider([], { model: "stub-render" }),
    store,
    mode: "live-with-capture",
    fetchOptions: { fetch: makeValidatorFetch(html, etag, lastModified, "304-when-validated", probe), sleep: async () => {} },
    log: () => {},
  });

  assert.equal(result.ok, false, "a requiresRender camp with no renderImpl still fails closed");
  assert.ok(result.error?.startsWith("invalid-config:"), `expected a typed invalid-config error, got: ${result.error}`);
  assert.equal(result.notModified ?? false, false, "a rendered recrawl is never notModified — revalidation does not apply to render:true");
  assert.equal(result.itemCount, 0, "no items were grouped from a failed rendered fetch");
  const anyValidatorSent = probe.mainRequestHeaders.some((h) => "If-None-Match" in h || "If-Modified-Since" in h);
  assert.equal(anyValidatorSent, false, "HTTP validators must never be sent on a rendered recrawl (revalidate is gated on !render)");

  console.log("✓ campfit#77 DOD-RENDER: a rendered recrawl never sends/reuses HTTP validators and retains fail-closed semantics even with a validated prior snapshot in the store");
}

// ─── 15. campfit#77 wiring: crawl-pipeline routes a notModified recrawl to the
// crawl-freshness seam and skips proposal/provider work (structural — the full
// DB path is exercised by the DB-backed integration suite, NOT_VERIFIED here
// with no TEST_DATABASE_URL) ───────────────────────────────────────────────

async function testCrawlPipelineWiresNotModifiedToFreshnessSeam() {
  const source = fs.readFileSync(path.join(ROOT_DIR, "lib/ingestion/crawl-pipeline.ts"), "utf8");
  assert.match(
    source,
    /import\s*{\s*recordRecrawlFreshness\s*}\s*from\s*['"]\.\/recrawl-freshness['"]/,
    "crawl-pipeline must import the crawl-freshness seam"
  );
  assert.match(
    source,
    /else if \(result\.notModified\)/,
    "crawl-pipeline must branch on result.notModified BEFORE the changed-page proposal block"
  );
  assert.match(
    source,
    /const freshnessUpdated = await recordRecrawlFreshness\(pool, \{ campId: camp\.id, checkedAt: new Date\(\) \}\)/,
    "the notModified branch must record crawl freshness (lastCrawledAt) for the exact camp, and consume the boolean return"
  );
  assert.match(
    source,
    /if \(!freshnessUpdated\) \{\s*console\.warn\(\s*`\[crawl\] freshness update skipped: camp \$\{camp\.id\} no longer exists/,
    "a missing/deleted camp row (false return) must be surfaced via a warning, not silently swallowed (review finding L1)"
  );
  console.log("✓ campfit#77 wiring: crawl-pipeline routes a notModified recrawl to recordRecrawlFreshness before any proposal/provider work, consumes the boolean return, and warns on a deleted-camp miss (full DB path NOT_VERIFIED here — see the DB integration suite)");
}

// ─── Run ────────────────────────────────────────────────────────────────

async function main() {
  testComputeDiffBehaviorTable();
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
  await testConditionalGet304SkipsExtractionAndRefreshesFreshness();
  await testConditionalGet200PreservesChangedPageBehavior();
  await testConditionalGetDoesNotApplyToRenderedRecrawl();
  await testCrawlPipelineWiresNotModifiedToFreshnessSeam();
  console.log("\ntraverse recrawl adapter verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
