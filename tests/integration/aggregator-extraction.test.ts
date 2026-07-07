/**
 * tests/integration/aggregator-extraction.test.ts — campfit#93 Wave 3 Task
 * 3.1 acceptance suite for `runAggregatorDiscovery` (R1/R2, AC1/AC2).
 *
 * Uses the SAME fixture-`FetchLike` seam `scripts/test-recrawl-adapter.ts` /
 * `scripts/test-traverse-cost-guards.ts` already use for
 * `TraversePipelineDeps.fetchOptions.fetch` (a fake serving fixed HTML by
 * URL, with `/robots.txt` answered as "no restrictions"), forwarded here to
 * `crawlSource`'s own `CrawlOptions.fetchOptions.fetch` — no network, no
 * timers (a `sleep: async () => {}` no-op keeps `crawlSource`'s per-host
 * politeness delay from slowing the suite down).
 *
 * The stub `ExtractionProvider` (`tests/fixtures/traverse/stub-provider.ts`,
 * the same one `test-traverse-replay.ts` uses) is handed ALL of the
 * fixture's specs up front; `extract()`'s own excerpt-verification step
 * (`indexOf` against each PAGE's own prepared content) is what makes only
 * the specs whose needle actually occurs on a given page survive for that
 * page — so this proves the real, unmocked `extract()` provenance path, not
 * a hand-rolled fake extraction result.
 *
 * Fixture site (same host, 3 pages, BFS depth 2 default budget):
 *   /camps            (seed)   — aggregator's own branding (never a
 *                                candidate) + 1 provider card, links to
 *                                /camps/page-a and /camps/page-b.
 *   /camps/page-a     (depth1) — 2 provider cards.
 *   /camps/page-b     (depth1) — 3 provider cards.
 *   => 6 distinct candidates total, each with its own excerpt/name/website.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "@kontourai/traverse/fetch";
import { createInMemorySnapshotStore } from "@kontourai/traverse/fetch";

import {
  createStubProvider,
  type StubProposalSpec,
} from "../fixtures/traverse/stub-provider";
import {
  AggregatorTosNotApprovedError,
  runAggregatorDiscovery,
  type AggregatorDiscoveryDeps,
} from "@/lib/ingestion/aggregator/aggregator-extraction";
import {
  createAggregatorSource,
  ensureAggregatorSourceSchema,
  recordTosDecision,
} from "@/lib/ingestion/aggregator/aggregator-repository";
import {
  ensureProviderCandidateSchema,
  getPendingCandidates,
} from "@/lib/ingestion/discovery/candidate-repository";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

const REVIEWER = "reviewer@campfit.test";
const AGGREGATOR_BRAND_NAME = "CampFinder Denver Directory";

const SEED_URL = "https://aggregator.example/camps";
const PAGE_A_URL = "https://aggregator.example/camps/page-a";
const PAGE_B_URL = "https://aggregator.example/camps/page-b";

const SEED_HTML = `
<!doctype html>
<html>
  <head><title>${AGGREGATOR_BRAND_NAME}</title></head>
  <body>
    <header><h1>${AGGREGATOR_BRAND_NAME}</h1><p>Your guide to Denver-area camps.</p></header>
    <main>
      <article class="card">
        <h2>Mountain Adventure Camp</h2>
        <p>Serving families in Denver, CO.</p>
        <a href="https://mountainadventure.example">Visit site</a>
      </article>
    </main>
    <nav>
      <a href="/camps/page-a">More camps (A-M)</a>
      <a href="/camps/page-b">More camps (N-Z)</a>
    </nav>
  </body>
</html>`;

const PAGE_A_HTML = `
<!doctype html>
<html>
  <head><title>${AGGREGATOR_BRAND_NAME} — Page A</title></head>
  <body>
    <main>
      <article class="card">
        <h2>Riverside Day Camp</h2>
        <p>Located in Boulder, CO.</p>
        <a href="https://riverside.example">Visit site</a>
      </article>
      <article class="card">
        <h2>Foothills Adventure Club</h2>
        <p>Located in Golden, CO.</p>
        <a href="https://foothillsadventure.example">Visit site</a>
      </article>
    </main>
  </body>
</html>`;

const PAGE_B_HTML = `
<!doctype html>
<html>
  <head><title>${AGGREGATOR_BRAND_NAME} — Page B</title></head>
  <body>
    <main>
      <article class="card">
        <h2>Summit STEM Academy</h2>
        <p>Located in Lakewood, CO.</p>
        <a href="https://summitstem.example">Visit site</a>
      </article>
      <article class="card">
        <h2>Wildflower Nature School</h2>
        <p>Located in Arvada, CO.</p>
        <a href="https://wildflowernature.example">Visit site</a>
      </article>
      <article class="card">
        <h2>Trailhead Robotics Camp</h2>
        <p>Located in Wheat Ridge, CO.</p>
        <a href="https://trailhead.example">Visit site</a>
      </article>
    </main>
  </body>
</html>`;

const PAGES: Record<string, string> = {
  [SEED_URL]: SEED_HTML,
  [PAGE_A_URL]: PAGE_A_HTML,
  [PAGE_B_URL]: PAGE_B_HTML,
};

/** Every candidate card across the whole fixture site, keyed by name (for assertions). */
const ALL_FIXTURE_CANDIDATES = [
  { name: "Mountain Adventure Camp", websiteUrl: "https://mountainadventure.example", locale: "Denver, CO", page: SEED_URL },
  { name: "Riverside Day Camp", websiteUrl: "https://riverside.example", locale: "Boulder, CO", page: PAGE_A_URL },
  { name: "Foothills Adventure Club", websiteUrl: "https://foothillsadventure.example", locale: "Golden, CO", page: PAGE_A_URL },
  { name: "Summit STEM Academy", websiteUrl: "https://summitstem.example", locale: "Lakewood, CO", page: PAGE_B_URL },
  { name: "Wildflower Nature School", websiteUrl: "https://wildflowernature.example", locale: "Arvada, CO", page: PAGE_B_URL },
  { name: "Trailhead Robotics Camp", websiteUrl: "https://trailhead.example", locale: "Wheat Ridge, CO", page: PAGE_B_URL },
];

/** Fake `FetchLike` serving the fixture site by URL; `/robots.txt` fails open (no restrictions). */
function makeFixtureFetch(calls: string[]): FetchLike {
  return async (fetchUrl: string) => {
    calls.push(fetchUrl);
    if (fetchUrl.endsWith("/robots.txt")) {
      return {
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/plain" : null) },
        text: async () => "User-agent: *\nDisallow:",
      };
    }
    const html = PAGES[fetchUrl];
    if (html === undefined) {
      return { status: 404, headers: { get: () => null }, text: async () => "not found" };
    }
    return {
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
      text: async () => html,
    };
  };
}

/**
 * A rule-based stub provider covering every candidate + item field across
 * the whole fixture site. Because `extract()` verifies each proposal's
 * excerpt actually occurs in the PAGE-SPECIFIC prepared content it is
 * called with, only the specs whose needle is present on a given page
 * survive for that page's `ExtractionResult` — a spec for Riverside Day
 * Camp is silently dropped (with a warning, not an error) when the provider
 * is called against the seed page's content, and vice versa.
 */
function buildStubSpecs(): StubProposalSpec[] {
  const specs: StubProposalSpec[] = [];
  ALL_FIXTURE_CANDIDATES.forEach((candidate, i) => {
    specs.push({ fieldPath: `items[${i}].name`, candidateValue: candidate.name, needle: candidate.name });
    specs.push({
      fieldPath: `items[${i}].websiteUrl`,
      candidateValue: candidate.websiteUrl,
      needle: candidate.websiteUrl,
    });
    specs.push({ fieldPath: `items[${i}].locale`, candidateValue: candidate.locale, needle: candidate.locale });
  });
  return specs;
}

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
  await ensureAggregatorSourceSchema(pool);
  await ensureProviderCandidateSchema(pool);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "ProviderCandidate", "Provider", "AggregatorSource" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

async function registerApprovedAggregator(): Promise<string> {
  const source = await createAggregatorSource(
    { name: "Denver Camp Finder", url: SEED_URL, communitySlug: "denver", maxPages: 10, maxDepth: 2 },
    pool,
  );
  await recordTosDecision(source.id, { decision: "APPROVED", reviewedBy: REVIEWER }, pool);
  return source.id;
}

function buildDeps(calls: string[]): AggregatorDiscoveryDeps {
  return {
    provider: createStubProvider(buildStubSpecs(), { model: "stub-aggregator" }),
    store: createInMemorySnapshotStore(),
    mode: "live-with-capture",
    fetchOptions: { fetch: makeFixtureFetch(calls), sleep: async () => {} },
    log: () => {},
  };
}

// ── AC1 — repository-level ToS gate ─────────────────────────────────────────

describe("AC1 — repository-level ToS gate", () => {
  it("throws AggregatorTosNotApprovedError and makes zero fetch calls for an unapproved aggregator", async () => {
    const source = await createAggregatorSource(
      { name: "Unreviewed Aggregator", url: SEED_URL, communitySlug: "denver" },
      pool,
    );

    const calls: string[] = [];
    await expect(
      runAggregatorDiscovery(source.id, { performedBy: REVIEWER }, buildDeps(calls), pool),
    ).rejects.toBeInstanceOf(AggregatorTosNotApprovedError);

    expect(calls).toHaveLength(0);
  });

  it("also refuses a DECLINED aggregator with zero fetch calls", async () => {
    const source = await createAggregatorSource(
      { name: "Declined Aggregator", url: SEED_URL, communitySlug: "denver" },
      pool,
    );
    await recordTosDecision(source.id, { decision: "DECLINED", reviewedBy: REVIEWER }, pool);

    const calls: string[] = [];
    await expect(
      runAggregatorDiscovery(source.id, { performedBy: REVIEWER }, buildDeps(calls), pool),
    ).rejects.toBeInstanceOf(AggregatorTosNotApprovedError);
    expect(calls).toHaveLength(0);
  });
});

// ── AC2 — fixture-based candidate + provenance proof ────────────────────────

describe("AC2 — candidate discovery with provenance", () => {
  it("enqueues >=5 distinct candidates, each with non-null provenance, from an APPROVED aggregator", async () => {
    const aggregatorSourceId = await registerApprovedAggregator();
    const calls: string[] = [];

    const summary = await runAggregatorDiscovery(
      aggregatorSourceId,
      { performedBy: REVIEWER },
      buildDeps(calls),
      pool,
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(summary.discoveredPages).toBe(3);
    expect(summary.enqueuedNew).toBeGreaterThanOrEqual(5);
    expect(summary.pageErrors).toEqual([]);

    const queued = await getPendingCandidates("denver", pool);
    expect(queued.length).toBeGreaterThanOrEqual(5);

    // Distinct names AND distinct provenance excerpts/locators — not 5 copies
    // of one card.
    const names = new Set(queued.map((c) => c.name));
    const excerpts = new Set(queued.map((c) => c.provenanceExcerpt));
    expect(names.size).toBe(queued.length);
    expect(excerpts.size).toBe(queued.length);

    for (const candidate of queued) {
      expect(candidate.provenanceExcerpt).toBeTruthy();
      expect(candidate.provenanceLocator).toMatch(/^chars:\d+-\d+$/);
      expect(candidate.snapshotSourceRef).toBeTruthy();
      expect(candidate.aggregatorSourceId).toBe(aggregatorSourceId);
      expect(candidate.locale).toBeTruthy();
    }

    // The aggregator's OWN branding never becomes a candidate.
    expect(names.has(AGGREGATOR_BRAND_NAME)).toBe(false);

    // Every fixture card's name shows up somewhere in the queue.
    for (const candidate of ALL_FIXTURE_CANDIDATES) {
      expect(names.has(candidate.name)).toBe(true);
    }
  });

  it("skips a card as exact-duplicate (by domain) when a matching Provider already exists, while the others still enqueue", async () => {
    await pool.query(
      `INSERT INTO "Provider" (name, slug, domain, "communitySlug") VALUES ($1, $2, $3, $4)`,
      ["Riverside Day Camp Inc.", `prov-${randomUUID()}`, "riverside.example", "denver"],
    );

    const aggregatorSourceId = await registerApprovedAggregator();
    const calls: string[] = [];

    const summary = await runAggregatorDiscovery(
      aggregatorSourceId,
      { performedBy: REVIEWER },
      buildDeps(calls),
      pool,
    );

    expect(summary.skippedDuplicate).toBe(1);
    expect(summary.enqueuedNew).toBe(ALL_FIXTURE_CANDIDATES.length - 1);

    const queued = await getPendingCandidates("denver", pool);
    const names = queued.map((c) => c.name);
    expect(names).not.toContain("Riverside Day Camp");
    for (const candidate of ALL_FIXTURE_CANDIDATES) {
      if (candidate.name === "Riverside Day Camp") continue;
      expect(names).toContain(candidate.name);
    }

    const skippedOutcome = summary.outcomes.find((o) => o.disposition === "skipped-duplicate");
    expect(skippedOutcome?.name).toBe("Riverside Day Camp");
    expect(skippedOutcome?.detail).toContain("riverside.example");
  });
});
// ── M fix — structural skipped-self filter ──────────────────────────────────

describe("M fix — skipped-self structural backstop", () => {
  const SELF_SOURCE_URL = "https://selftest.example/list";

  const SELF_TEST_HTML = `
<!doctype html>
<html>
  <head><title>Self Test Directory</title></head>
  <body>
    <main>
      <article class="card">
        <h2>External Family Camp</h2>
        <p>Serving families in Denver, CO.</p>
        <a href="https://external-camp.example">Visit site</a>
      </article>
      <article class="card">
        <h2>Aggregator's Own Listing</h2>
        <p>Serving families in Denver, CO.</p>
        <a href="https://selftest.example/own-listing">Visit site</a>
      </article>
      <article class="card">
        <h2>Aggregator's WWW-Variant Listing</h2>
        <p>Serving families in Denver, CO.</p>
        <a href="https://www.selftest.example/promo">Visit site</a>
      </article>
    </main>
  </body>
</html>`;

  const SELF_TEST_CANDIDATES = [
    { name: "External Family Camp", websiteUrl: "https://external-camp.example" },
    { name: "Aggregator's Own Listing", websiteUrl: "https://selftest.example/own-listing" },
    { name: "Aggregator's WWW-Variant Listing", websiteUrl: "https://www.selftest.example/promo" },
  ];

  function selfTestFetch(calls: string[]): FetchLike {
    return async (fetchUrl: string) => {
      calls.push(fetchUrl);
      if (fetchUrl.endsWith("/robots.txt")) {
        return {
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/plain" : null) },
          text: async () => "User-agent: *\nDisallow:",
        };
      }
      if (fetchUrl === SELF_SOURCE_URL) {
        return {
          status: 200,
          headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
          text: async () => SELF_TEST_HTML,
        };
      }
      return { status: 404, headers: { get: () => null }, text: async () => "not found" };
    };
  }

  function selfTestStubSpecs(): StubProposalSpec[] {
    const specs: StubProposalSpec[] = [];
    SELF_TEST_CANDIDATES.forEach((candidate, i) => {
      specs.push({ fieldPath: `items[${i}].name`, candidateValue: candidate.name, needle: candidate.name });
      specs.push({
        fieldPath: `items[${i}].websiteUrl`,
        candidateValue: candidate.websiteUrl,
        needle: candidate.websiteUrl,
      });
    });
    return specs;
  }

  it("drops candidates whose websiteUrl domain (bare or www-variant) matches the aggregator's own domain, while an external-domain candidate still enqueues", async () => {
    const source = await createAggregatorSource(
      { name: "Self Test Aggregator", url: SELF_SOURCE_URL, communitySlug: "denver", maxPages: 1, maxDepth: 0 },
      pool,
    );
    await recordTosDecision(source.id, { decision: "APPROVED", reviewedBy: REVIEWER }, pool);

    const calls: string[] = [];
    const deps: AggregatorDiscoveryDeps = {
      provider: createStubProvider(selfTestStubSpecs(), { model: "stub-self-test" }),
      store: createInMemorySnapshotStore(),
      mode: "live-with-capture",
      fetchOptions: { fetch: selfTestFetch(calls), sleep: async () => {} },
      log: () => {},
    };

    const summary = await runAggregatorDiscovery(source.id, { performedBy: REVIEWER }, deps, pool);

    // The two self-domain cards (bare + www-variant) are both dropped by the
    // structural backstop, never reaching classification/enqueue.
    expect(summary.skippedSelf).toBe(2);
    expect(summary.enqueuedNew).toBe(1);

    const skippedOutcomes = summary.outcomes.filter((o) => o.disposition === "skipped-self");
    expect(skippedOutcomes).toHaveLength(2);
    expect(skippedOutcomes.map((o) => o.name).sort()).toEqual(
      ["Aggregator's Own Listing", "Aggregator's WWW-Variant Listing"].sort(),
    );

    // Absence assertion, not just the counter: no ProviderCandidate row for
    // either self-domain card, while the external candidate IS queued.
    const queued = await getPendingCandidates("denver", pool);
    const queuedNames = queued.map((c) => c.name);
    expect(queuedNames).toContain("External Family Camp");
    expect(queuedNames).not.toContain("Aggregator's Own Listing");
    expect(queuedNames).not.toContain("Aggregator's WWW-Variant Listing");
    expect(queued).toHaveLength(1);
  });
});
