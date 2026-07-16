/**
 * test-l4-provider-drift.ts — campfit#134 verification (offline, no DB).
 *
 * Proves the sources-strategy drift gate's LOGIC: a Lookout CHECK
 * (`runLookoutCheck`/`isLookoutUnchanged`, lookout-check-adapter.ts) against
 * a `providerSourceToLookoutSource`-keyed source, gating whether
 * `runTraversePipelineForSource` (traverse-pipeline.ts) ever runs at all —
 * exactly the sequence `crawl-pipeline.ts`'s `CrawlOptions.driftGate` branch
 * performs inside `runSourceSweepStrategy`.
 *
 * This cannot call `runSourceSweepStrategy`/`runCrawlPipeline({ sources })`
 * directly: that function unconditionally calls `getPool()` (`@/lib/db`)
 * plus `startRun`/`createProposal`/`ensureAnchorCamp`, which need a real
 * Postgres connection — there is no vitest-style module mocking available in
 * a plain `tsx` script (unlike `tests/integration/crawl-pipeline-sources-strategy.test.ts`,
 * which uses `vi.mock`). So this test instead composes the SAME production
 * primitives the driftGate branch calls, in the SAME sequence, with a
 * DB-free fake standing in for the anchor-camp/proposal-persistence layer —
 * proving the LOGIC (drift check -> skip-or-extract -> scalar diff ->
 * changesFound gate) is correct, exactly like test-l4-lookout-discovery.ts
 * and test-l4-lookout-check.ts already do for their own composed paths (they
 * don't call runCrawlPipeline either).
 *
 * No network: fetches route through the real SSRF-guarded fetch
 * (`createGuardedTraverseFetchOptions`, invoked internally by both
 * `runLookoutCheck` and `runTraversePipelineForSource`) with a fixture
 * `egressResponseOracle`/`egressResolver` serving canned HTML — the exact
 * convention scripts/test-traverse-crawl.ts and
 * scripts/test-traverse-cost-guards.ts already prove works for this
 * composed setup (a raw injected `fetch` is refused by the guard as
 * UNTRUSTED_TRANSPORT, so the oracle is the only network-free path in).
 *
 * The skip is gated on `unchanged-304` ONLY (campfit#134 HIGH fix), NOT
 * `unchanged-hash`: this CHECK does a PLAIN fetch, but the extraction path
 * renders JS-shell provider pages — so a byte-identical plain-fetch body
 * (`unchanged-hash`) can't prove the RENDERED content is unchanged, and an
 * invariant JS shell would otherwise be skipped permanently. Only an
 * authoritative server 304 (validator match) is render-independent and safe
 * to skip on. A `unchanged-hash` result falls through to the shell-aware
 * extraction, which produces zero proposals if genuinely unchanged (the
 * sink's `changesFound > 0` gate). This harness can't drive a real
 * `unchanged-304` (the in-memory fixture serves no ETag/Last-Modified
 * validators, so the fetch layer never issues a conditional request) — the
 * authoritative-304-skips path is covered by the DB-backed integration test
 * (`tests/integration/crawl-pipeline-sources-strategy.test.ts`, which mocks
 * a `unchanged-304` CheckResult). This script proves the safety-critical
 * half: `unchanged-hash` does NOT skip.
 *
 * Asserts:
 *  1. Run 1 (cold, no prior snapshot): both fixture provider sources CHECK
 *     as "changed" -> extraction runs for both -> one proposal record per
 *     source's single item.
 *  2. Run 2 (identical content, no mutation): both sources CHECK as
 *     "unchanged-hash" -> extraction is NOT skipped (the shell-safety
 *     property) -> extract() DOES run for both -> but ZERO new proposals,
 *     because the re-extracted content is unchanged vs. current DB values.
 *  3. Run 3 (only provider A's page changes — one new item, one changed
 *     scalar on the existing item): provider A CHECKs "changed" and yields
 *     exactly the expected delta (one populate record for the new item, one
 *     update record for the existing item's single changed field); provider
 *     B CHECKs "unchanged-hash" — its extraction re-runs (not skipped) but
 *     yields zero proposals (unchanged vs. current DB values).
 */

import assert from "node:assert/strict";
import {
  createInMemorySnapshotStore,
  fetchSource as traverseFetchSource,
  type FetchSourceOptions,
  type SnapshotStore,
} from "@kontourai/traverse/fetch";
import type { ExtractionProposal, ExtractionProvider } from "@kontourai/traverse";
import { providerSourceToLookoutSource } from "../lib/ingestion/lookout-sources";
import { runLookoutCheck } from "../lib/ingestion/lookout-check-adapter";
import {
  runTraversePipelineForSource,
  type TraverseProposalSink,
  type TraversePipelineSourceResult,
} from "../lib/ingestion/traverse-pipeline";
import type { IngestionSourceConfig } from "../lib/ingestion/sources";
import { slugify } from "../lib/ingestion/slug";
import type { EgressResolver, EgressResponseOracle } from "../lib/security/egress-url-policy";

type OracleFetchOptions = FetchSourceOptions & {
  egressResolver: EgressResolver;
  egressResponseOracle: EgressResponseOracle;
};

// ─── Network-free fixture fetch options (mirrors test-traverse-crawl.ts /
// test-traverse-cost-guards.ts's makeFixtureFetchOptions convention) ───────

const fixtureResolver: EgressResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function buildFetchOptions(html: string): OracleFetchOptions {
  return {
    sleep: async () => {},
    egressResolver: fixtureResolver,
    egressResponseOracle: {
      responses: [
        { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:", headers: { "content-type": "text/plain" }, repeat: true },
        { status: 200, body: html, headers: { "content-type": "text/html; charset=utf-8" }, repeat: true },
      ],
    },
  };
}

// ─── Fixture content ────────────────────────────────────────────────────

interface FixtureItem {
  name: string;
  status: string;
}

function pageHtml(items: FixtureItem[]): string {
  const rows = items
    .map((it) => `<li>${it.name} — registration is currently ${it.status}.</li>`)
    .join("");
  return `<html><body><h1>Programs</h1><ul>${rows}</ul></body></html>`;
}

// ─── Counting stub ExtractionProvider ──────────────────────────────────────
//
// Reads the CURRENT contents of `itemsRef` at call time (mutated between
// "runs" below), mirroring test-l4-lookout-discovery.ts's
// providerNames/body mutation pattern. Raw indexed fieldPaths
// (`items[N].name`) are what a real provider echoes back — traverse's own
// extract() normalizes them into the declared `items[].name` form +
// `pathIndices` (see traverse-schema.ts's file doc), exactly like
// scripts/test-traverse-crawl.ts's stub usage.

function makeCountingProvider(model: string, itemsRef: { current: FixtureItem[] }): { provider: ExtractionProvider; state: { calls: number } } {
  const state = { calls: 0 };
  const provider: ExtractionProvider = {
    name: `stub:${model}`,
    async extract({ content }) {
      state.calls++;
      const proposals: ExtractionProposal[] = [];
      itemsRef.current.forEach((it, i) => {
        const statusExcerpt = `registration is currently ${it.status}`;
        proposals.push({
          fieldPath: `items[${i}].name`,
          candidateValue: it.name,
          confidence: 0.9,
          provenance: { excerpt: it.name, locator: `provisional:${content.indexOf(it.name)}` },
          extractor: `stub:${model}`,
        });
        proposals.push({
          fieldPath: `items[${i}].registrationStatus`,
          candidateValue: it.status,
          confidence: 0.9,
          provenance: { excerpt: statusExcerpt, locator: `provisional:${content.indexOf(statusExcerpt)}` },
          extractor: `stub:${model}`,
        });
      });
      return { proposals, raw: { response: "{}", model } };
    },
  };
  return { provider, state };
}

// ─── DB-free fakes standing in for the anchor-camp/proposal-persistence
// layer (`ensureAnchorCamp`/`createProposal`/`lookupCurrentBySlug`) ───────

interface FakeProposal {
  sourceKey: string;
  itemName: string;
  fieldsChanged: string[];
}

const fakeCamps = new Map<string, Record<string, unknown>>(); // keyed by slug
const proposals: FakeProposal[] = [];

/** Mirrors lookupCurrentBySlug (scripts/crawl-aggregator-providers.ts / scripts/scrape.ts). */
async function fakeCurrentByItemNames(_sourceKey: string, itemNames: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const name of itemNames) {
    const slug = slugify(name);
    const current = slug ? fakeCamps.get(slug) : undefined;
    if (current) out.set(name, current);
  }
  return out;
}

/**
 * Mirrors crawl-pipeline.ts's fixed sink (campfit#134 bug 3): anchor
 * unconditionally, create a proposal ONLY when changesFound > 0. Also applies
 * the proposed scalar values onto the fake camp, modelling the populated /
 * post-approval steady state — so a later IDENTICAL extraction diffs to zero
 * against current DB values (the review-noise property the
 * `unchanged-hash`-falls-through-to-extraction path relies on: extraction
 * re-runs but produces no proposals when nothing actually changed).
 */
const fakeSink: TraverseProposalSink = async (record, meta) => {
  const slug = slugify(record.itemName) || `item-${record.itemName}`;
  const camp = fakeCamps.get(slug) ?? { name: record.itemName };
  fakeCamps.set(slug, camp); // ensureAnchorCamp: unconditional
  const changesFound = Object.keys(record.proposedChanges).length;
  if (changesFound === 0) return null;
  for (const [field, diff] of Object.entries(record.proposedChanges)) {
    camp[field] = (diff as { new?: unknown }).new;
  }
  proposals.push({ sourceKey: meta.sourceKey, itemName: record.itemName, fieldsChanged: Object.keys(record.proposedChanges) });
  return `fake-proposal-${proposals.length}`;
};

// ─── The composed driftGate branch under test — mirrors crawl-pipeline.ts's
// runSourceSweepStrategy driftGate branch EXACTLY: CHECK first (reusing the
// same SnapshotStore for both CHECK and extraction), skip-if-unchanged,
// else fall through to runTraversePipelineForSource. ───────────────────────

async function runOneSourceThroughDriftGate(
  src: IngestionSourceConfig,
  store: SnapshotStore,
  provider: ExtractionProvider,
  html: string,
): Promise<{ skipped: boolean; checkKind: string; result?: TraversePipelineSourceResult }> {
  const fetchOptions = buildFetchOptions(html);
  const checkResult = await runLookoutCheck(providerSourceToLookoutSource(src), {
    store,
    fetchSource: traverseFetchSource,
    fetchOptions,
  });
  // Mirrors crawl-pipeline.ts's driftGate branch EXACTLY (campfit#134 HIGH
  // fix): skip extraction ONLY on an authoritative server 304, never on a
  // plain-fetch `unchanged-hash` (which can't prove rendered content is
  // unchanged).
  if (checkResult.kind === "unchanged-304") {
    return { skipped: true, checkKind: checkResult.kind };
  }
  const result = await runTraversePipelineForSource(src, {
    provider,
    store,
    sink: fakeSink,
    mode: "live-with-capture",
    currentByItemNames: fakeCurrentByItemNames,
    fetchOptions,
  });
  return { skipped: false, checkKind: checkResult.kind, result };
}

// ─── Fixture sources + world state ─────────────────────────────────────────

const alderSrc: IngestionSourceConfig = { key: "agg:fixture:alder", name: "Alder Camps", url: "https://fixture.example/alder" };
const beaconSrc: IngestionSourceConfig = { key: "agg:fixture:beacon", name: "Beacon Camps", url: "https://fixture.example/beacon" };

const alderItemsRef = { current: [{ name: "Alder Hiking", status: "OPEN" }] as FixtureItem[] };
const beaconItemsRef = { current: [{ name: "Beacon Art", status: "OPEN" }] as FixtureItem[] };

const alder = makeCountingProvider("alder-stub", alderItemsRef);
const beacon = makeCountingProvider("beacon-stub", beaconItemsRef);

const store = createInMemorySnapshotStore();

// ─── Run 1: cold — no prior snapshot for either source ─────────────────────

{
  const rAlder = await runOneSourceThroughDriftGate(alderSrc, store, alder.provider, pageHtml(alderItemsRef.current));
  assert.equal(rAlder.skipped, false, "run 1: cold CHECK must not skip extraction");
  assert.equal(rAlder.checkKind, "changed", "run 1: cold CHECK has no prior snapshot to compare against");
  assert.equal(alder.state.calls, 1, "run 1: alder extract() called exactly once");

  const rBeacon = await runOneSourceThroughDriftGate(beaconSrc, store, beacon.provider, pageHtml(beaconItemsRef.current));
  assert.equal(rBeacon.skipped, false, "run 1: cold CHECK must not skip extraction");
  assert.equal(rBeacon.checkKind, "changed");
  assert.equal(beacon.state.calls, 1, "run 1: beacon extract() called exactly once");

  assert.equal(proposals.length, 2, "run 1: one proposal record per source's single item");
  assert.ok(proposals.some((p) => p.sourceKey === alderSrc.key && p.itemName === "Alder Hiking"));
  assert.ok(proposals.some((p) => p.sourceKey === beaconSrc.key && p.itemName === "Beacon Art"));
}

// ─── Run 2: identical content, no mutation — the SAFETY-CRITICAL regression
// guard for the campfit#134 HIGH (JS-shell permanent-skip). A byte-identical
// plain-fetch body is `unchanged-hash`, NOT an authoritative 304, so it must
// NOT skip: extraction re-runs (proving a JS-shell page would still be
// re-rendered/re-extracted every cycle), and — because the content is
// unchanged vs. current DB values — yields ZERO new proposals. ───────────────

{
  const proposalsBefore = proposals.length;
  const alderCallsBefore = alder.state.calls;
  const beaconCallsBefore = beacon.state.calls;

  const rAlder = await runOneSourceThroughDriftGate(alderSrc, store, alder.provider, pageHtml(alderItemsRef.current));
  assert.equal(rAlder.checkKind, "unchanged-hash", "run 2: identical plain-fetch body is unchanged-hash, not 304");
  assert.equal(rAlder.skipped, false, "run 2: unchanged-hash must NOT skip — a JS shell would otherwise be skipped permanently (campfit#134 HIGH)");

  const rBeacon = await runOneSourceThroughDriftGate(beaconSrc, store, beacon.provider, pageHtml(beaconItemsRef.current));
  assert.equal(rBeacon.checkKind, "unchanged-hash");
  assert.equal(rBeacon.skipped, false, "run 2: unchanged-hash must NOT skip");

  assert.equal(alder.state.calls, alderCallsBefore + 1, "run 2: alder extraction re-ran (hash-unchanged falls through to the shell-aware extraction)");
  assert.equal(beacon.state.calls, beaconCallsBefore + 1, "run 2: beacon extraction re-ran");
  assert.equal(proposals.length, proposalsBefore, "run 2: re-extraction of unchanged content yields zero new proposals (currentByItemNames diff + changesFound gate)");
}

// ─── Run 3: only provider A's page changes (one new item + one changed
// scalar field on the existing item). Provider B is untouched: its extraction
// re-runs (unchanged-hash, not skipped) but yields zero proposals. ──────────

{
  alderItemsRef.current = [
    { name: "Alder Hiking", status: "WAITLIST" }, // scalar change: registrationStatus OPEN -> WAITLIST
    { name: "Cedar Science", status: "OPEN" }, // brand-new item
  ];

  const proposalsBefore = proposals.length;
  const alderCallsBefore = alder.state.calls;
  const beaconCallsBefore = beacon.state.calls;

  const rAlder = await runOneSourceThroughDriftGate(alderSrc, store, alder.provider, pageHtml(alderItemsRef.current));
  assert.equal(rAlder.skipped, false, "run 3: alder's changed page must not be skipped");
  assert.equal(rAlder.checkKind, "changed");
  assert.equal(alder.state.calls, alderCallsBefore + 1, "run 3: exactly one new alder extract() call");

  const rBeacon = await runOneSourceThroughDriftGate(beaconSrc, store, beacon.provider, pageHtml(beaconItemsRef.current));
  assert.equal(rBeacon.checkKind, "unchanged-hash");
  assert.equal(rBeacon.skipped, false, "run 3: beacon's untouched page is unchanged-hash → NOT skipped (re-extracts)");
  assert.equal(beacon.state.calls, beaconCallsBefore + 1, "run 3: beacon extraction re-ran (unchanged-hash falls through)");

  const newProposals = proposals.slice(proposalsBefore);
  assert.equal(newProposals.length, 2, "run 3: exactly one update record + one populate record — the untouched provider B contributes nothing");
  assert.ok(newProposals.every((p) => p.sourceKey === alderSrc.key), "run 3: no proposal belongs to provider B (re-extracted but unchanged)");

  const existingItemProposal = newProposals.find((p) => p.itemName === "Alder Hiking");
  assert.ok(existingItemProposal, "run 3: the existing item's changed scalar produced a proposal");
  assert.deepEqual(existingItemProposal!.fieldsChanged, ["registrationStatus"], "run 3: only the one changed scalar field, not name (unchanged)");

  const newItemProposal = newProposals.find((p) => p.itemName === "Cedar Science");
  assert.ok(newItemProposal, "run 3: the brand-new item produced a proposal");
  assert.deepEqual([...newItemProposal!.fieldsChanged].sort(), ["name", "registrationStatus"], "run 3: a never-before-seen item populates every scalar it has");
}

console.log("PASS L4 provider drift gate: cold CHECK extracts; a plain-fetch unchanged-hash does NOT skip (JS-shell safety — extraction re-runs, zero proposals); a changed source yields exactly its delta while an unchanged sibling re-extracts to zero proposals. (Authoritative-304 skip covered by the DB integration test.)");
