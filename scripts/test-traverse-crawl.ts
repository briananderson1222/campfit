/**
 * scripts/test-traverse-crawl.ts — campfit#133 verification (offline, no DB).
 *
 * Proves the sources strategy's bounded link-following crawl: a source that
 * opts into `maxPages`/`maxDepth` follows same-host links to reach camps on a
 * `/camps` SUBPAGE, extracting across the crawled page set — while a source
 * WITHOUT those bounds keeps today's exact single-page behavior. Uses the same
 * stub-provider + in-memory-snapshot-store + egress-response-oracle convention
 * as scripts/test-traverse-cost-guards.ts (the oracle keeps the real SSRF
 * `discoveredLink` guard active while serving fixture pages — no raw injected
 * fetch, which the guard would refuse as UNTRUSTED_TRANSPORT).
 *
 * Content-aware fixture: the stub emits a "Rocketry Camp" proposal whose
 * excerpt needle is present ONLY on the `/camps` page, so traverse's
 * excerpt-verification DROPS it on the seed homepage (0 items) and KEEPS it on
 * the crawled subpage (1 item) — the exact "camps live one click deeper" shape
 * the issue diagnoses.
 */

import assert from "node:assert/strict";
import { createInMemorySnapshotStore } from "@kontourai/traverse/fetch";
import type { FetchSourceOptions } from "@kontourai/traverse/fetch";
import { runTraversePipelineForSource } from "../lib/ingestion/traverse-pipeline";
import { createStubProvider } from "../tests/fixtures/traverse/stub-provider";
import type { EgressResponseOracle, EgressResolver } from "../lib/security/egress-url-policy";

type OracleFetchOptions = FetchSourceOptions & {
  egressResponseOracle: EgressResponseOracle;
  egressResolver: EgressResolver;
};

const SEED_HTML =
  "<html><body><h1>Acme Kids Programs</h1>" +
  "<p>Welcome to Acme. We run enrichment programs for kids across the metro.</p>" +
  '<a href="/camps">See all our summer camps</a>' +
  "</body></html>";

// The camp NAME lives only here — so the seed page's extraction drops the
// stub's proposal (needle absent) and only the crawled /camps page keeps it.
const CAMPS_HTML =
  "<html><body><h1>Our Summer Camps</h1><ul>" +
  "<li>Rocketry Camp — ages 8-12, a hands-on model-rocketry program running weekly in June.</li>" +
  "</ul></body></html>";

function makeCrawlFixtureFetchOptions(
  pages: Record<string, string>,
  resolver?: EgressResolver,
): OracleFetchOptions {
  return {
    sleep: async () => {},
    egressResolver: resolver ?? (async () => [{ address: "93.184.216.34", family: 4 }]),
    egressResponseOracle: {
      responses: [
        { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:", headers: { "content-type": "text/plain" }, repeat: true },
        ...Object.entries(pages).map(([urlSuffix, body]) => ({
          status: 200,
          urlSuffix,
          body,
          headers: { "content-type": "text/html; charset=utf-8" },
          repeat: true,
        })),
      ],
    },
  };
}

const rocketrySpec = [
  { fieldPath: "items[0].name", candidateValue: "Rocketry Camp", needle: "Rocketry Camp" },
];

// ─── 1. Crawl mode reaches the /camps subpage and extracts its camp ───────

async function testCrawlReachesSubpage() {
  const routed: { sourceUrl: string }[] = [];
  const result = await runTraversePipelineForSource(
    { key: "crawl-acme", name: "Acme", url: "https://crawl.test/home", maxPages: 6, maxDepth: 1 },
    {
      provider: createStubProvider(rocketrySpec, { model: "crawl-stub" }),
      store: createInMemorySnapshotStore(),
      sink: async (_record, meta) => {
        routed.push({ sourceUrl: meta.sourceUrl });
        return `p-${routed.length}`;
      },
      mode: "live-with-capture",
      fetchOptions: makeCrawlFixtureFetchOptions({ "/home": SEED_HTML, "/camps": CAMPS_HTML }),
      log: () => {},
    },
  );

  assert.ok(result.ok, `crawl should succeed: ${result.fetchError ?? result.extractionError ?? "unknown"}`);
  assert.equal(result.itemCount, 1, "exactly one camp — found on the crawled /camps subpage, not the seed homepage");
  assert.equal(result.routedProposalIds.filter((id) => id !== null).length, 1, "the camp is routed to the sink");
  assert.equal(routed.length, 1);
  assert.ok(
    routed[0]!.sourceUrl.endsWith("/camps"),
    `the camp's provenance URL must be the crawled /camps subpage, got ${routed[0]!.sourceUrl}`,
  );
  console.log(`✓ crawl mode follows the seed -> /camps link and extracts the subpage's camp (${result.itemCount} item, provenance ${routed[0]!.sourceUrl})`);
}

// ─── 2. Default (no bounds) stays single-page — behavior byte-unchanged ───

async function testSinglePageDefaultDoesNotReachSubpage() {
  const result = await runTraversePipelineForSource(
    // No maxPages/maxDepth → the legacy single-page path: only the seed homepage
    // is fetched, and it has no camp names, so nothing is extracted.
    { key: "single-acme", name: "Acme", url: "https://crawl.test/home" },
    {
      provider: createStubProvider(rocketrySpec, { model: "single-stub" }),
      store: createInMemorySnapshotStore(),
      sink: async () => "should-not-be-called",
      mode: "live-with-capture",
      fetchOptions: makeCrawlFixtureFetchOptions({ "/home": SEED_HTML, "/camps": CAMPS_HTML }),
      log: () => {},
    },
  );

  assert.ok(result.ok, "the single-page fetch of the homepage still succeeds");
  assert.equal(
    result.itemCount,
    0,
    "single-page mode must NOT reach /camps — the homepage has no camps, proving the crawl (not a fixture accident) is the lever and default behavior is preserved",
  );
  console.log("✓ default single-page mode fetches only the homepage (0 camps) — crawl bounds are the lever, legacy behavior unchanged");
}

// ─── 3. Followed-crawl egress is SSRF-guarded (discoveredLink profile) ────

async function testCrawlEgressGuardRefusesPrivateHost() {
  const result = await runTraversePipelineForSource(
    { key: "crawl-ssrf", name: "SSRF", url: "https://crawl.test/home", maxPages: 6, maxDepth: 1 },
    {
      provider: createStubProvider(rocketrySpec, { model: "ssrf-stub" }),
      store: createInMemorySnapshotStore(),
      sink: async () => null,
      mode: "live-with-capture",
      // The seed host resolves to a link-local (cloud-metadata) address — the
      // discoveredLink guard must refuse it before any content is fetched.
      fetchOptions: makeCrawlFixtureFetchOptions(
        { "/home": SEED_HTML, "/camps": CAMPS_HTML },
        async () => [{ address: "169.254.169.254", family: 4 }],
      ),
      log: () => {},
    },
  );

  assert.ok(!result.ok, "a crawl whose seed egress is refused must not be ok");
  assert.equal(result.itemCount, 0, "no content is extracted from a refused host");
  assert.ok(
    result.fetchError !== null,
    `the egress refusal must surface as a fetch error, got fetchError=${result.fetchError}`,
  );
  console.log(`✓ crawl egress is SSRF-guarded — a seed resolving to 169.254.169.254 is refused (${result.fetchError})`);
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function main() {
  await testCrawlReachesSubpage();
  await testSinglePageDefaultDoesNotReachSubpage();
  await testCrawlEgressGuardRefusesPrivateHost();
  console.log("\ntraverse sources-strategy crawl frontier (campfit#133) verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
