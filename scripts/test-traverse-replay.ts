/**
 * test-traverse-replay.ts — REPLAY-mode proof for the @kontourai/traverse
 * pilot (Slice 1b). No network, no API key: a deterministic stub provider runs
 * traverse extraction over two STORED HTML snapshots and asserts the pipeline
 * plumbing end-to-end.
 *
 * Snapshots (tests/fixtures/traverse/):
 *  - avid4-healthy.html        — a healthy source with a well-formed card.
 *  - denver-art-museum.html    — the RESCUE case: the relocated DAM page whose
 *                                rebuilt markup makes the legacy
 *                                DenverArtMuseumScraper selectors match zero
 *                                elements (0 camps), while schema-directed
 *                                traverse extraction still reads the facts.
 *
 * Asserts:
 *  1. Provenance excerpts are VERIFIED against the prepared text and locators
 *     are derived as chars:<start>-<end> with correct offsets.
 *  2. Warnings are surfaced (excerpt-not-found drop, confidence clamp,
 *     provider passthrough) — nothing dropped silently.
 *  3. Proposals ROUTE into the existing review path (ProposedChanges /
 *     createProposal-shaped record) with excerpt + sourceUrl provenance.
 *  4. Denver rescue: legacy scraper → 0 camps; traverse → N>0 proposals.
 *  5. Per-source isolation preserved on extraction failure: a provider that
 *     throws yields result.error (extract() never throws) and does not stop
 *     the next source in a sweep.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as cheerio from "cheerio";
import { prepareContent } from "@kontourai/traverse";
import {
  runTraverseExtraction,
  traverseProposalsToProposedChanges,
  buildTraverseProposalRecord,
} from "../lib/ingestion/traverse-extractor";
import { DenverArtMuseumScraper } from "../lib/ingestion/scrapers/denver-arts";
import { ScrapeContext } from "../lib/ingestion/scraper-base";
import { createStubProvider, StubProposalSpec } from "../tests/fixtures/traverse/stub-provider";

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

const LOCATOR_RE = /^chars:(\d+)-(\d+)$/;

/** Assert every surviving proposal's excerpt + locator is internally consistent. */
function assertProvenanceVerified(prepared: string, proposals: { fieldPath: string; provenance: { excerpt: string; locator: string } }[]) {
  for (const p of proposals) {
    assert.ok(
      prepared.includes(p.provenance.excerpt),
      `excerpt for "${p.fieldPath}" must occur in prepared text`
    );
    const m = p.provenance.locator.match(LOCATOR_RE);
    assert.ok(m, `locator for "${p.fieldPath}" must be chars:<start>-<end>, got "${p.provenance.locator}"`);
    const start = Number(m![1]);
    const end = Number(m![2]);
    assert.equal(end - start, p.provenance.excerpt.length, `locator span for "${p.fieldPath}" must equal excerpt length`);
    assert.equal(
      prepared.slice(start, end),
      p.provenance.excerpt,
      `locator offsets for "${p.fieldPath}" must slice out the exact excerpt`
    );
  }
}

// ─── 1 + 2 + 3. Healthy source: provenance, warnings, routing ──────────────

async function testHealthySourceReplay() {
  const html = loadFixture("avid4-healthy.html");
  const sourceRef = "https://avid4.com/day-camps/colorado/";
  const prepared = prepareContent(html, "html", 32_000).text ?? "";

  const specs: StubProposalSpec[] = [
    { fieldPath: "name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "category", candidateValue: "NATURE", needle: "hiking, climbing, and paddling" },
    { fieldPath: "applicationUrl", candidateValue: "https://avid4.com/register/mountain-explorers", needle: "Register now" },
    { fieldPath: "ageGroups[].minAge", candidateValue: 6, needle: "Ages 6-12" },
    { fieldPath: "ageGroups[].maxAge", candidateValue: 12, needle: "Ages 6-12" },
    { fieldPath: "schedules[].startDate", candidateValue: "2026-06-09", needle: "June 9-13, 2026" },
    { fieldPath: "pricing[].amount", candidateValue: 425, needle: "$425 per week" },
    // Out-of-range confidence → clamped to 1 with a warning (never dropped).
    { fieldPath: "city", candidateValue: "Boulder", needle: "Boulder, Colorado", confidence: 1.4 },
    // Excerpt not present in prepared text → dropped with a warning.
    { fieldPath: "neighborhood", candidateValue: "Highlands", needle: "THIS PHRASE IS NOT ON THE PAGE" },
  ];

  const provider = createStubProvider(specs, {
    model: "stub-1",
    warnings: ["provider-side: sample truncation note"],
  });

  const result = await runTraverseExtraction({ content: html, sourceRef, provider, maxContentChars: 32_000 });

  assert.equal(result.error, undefined, "healthy extraction must not error");

  // One spec dropped (excerpt-not-found) → 8 survive.
  assert.equal(result.proposals.length, 8, "8 of 9 stub proposals should survive normalization");
  assert.ok(!result.proposals.some((p) => p.fieldPath === "neighborhood"), "the not-found-excerpt proposal must be dropped");

  // 1. provenance verified + locators derived
  assertProvenanceVerified(prepared, result.proposals);
  assert.ok(
    result.proposals.every((p) => LOCATOR_RE.test(p.provenance.locator)),
    "every surviving proposal has a derived chars:<a>-<b> locator"
  );

  // 2. warnings surfaced: drop + clamp + provider passthrough
  const warnings = result.warnings ?? [];
  assert.ok(warnings.some((w) => w.includes("excerpt not found in prepared content")), "not-found drop must warn");
  assert.ok(warnings.some((w) => w.includes("clamped out-of-range confidence") && w.includes("city")), "clamp must warn");
  assert.ok(warnings.some((w) => w.includes("provider-side: sample truncation note")), "provider warnings must pass through");

  // clamp applied to the value too
  const cityProp = result.proposals.find((p) => p.fieldPath === "city")!;
  assert.equal(cityProp.confidence, 1, "out-of-range 1.4 confidence must clamp to 1");

  // 3. routed into the review path
  const current = { name: "Avid4 Adventure Camp", city: "" };
  const changes = traverseProposalsToProposedChanges(result.proposals, current, sourceRef);
  assert.ok(changes["name"], "scalar 'name' change routed");
  assert.equal(changes["name"].new, "Mountain Explorers Day Camp");
  assert.equal(changes["name"].mode, "update", "name differs from current → update");
  assert.equal(changes["city"].mode, "populate", "empty current city → populate");
  assert.ok(changes["schedules[].startDate"], "nested schedule path routed");
  assert.equal(changes["schedules[].startDate"].mode, "add_items");
  for (const key of Object.keys(changes)) {
    assert.ok(typeof changes[key].excerpt === "string" && changes[key].excerpt!.length > 0, `FieldDiff for ${key} carries an excerpt`);
    assert.equal(changes[key].sourceUrl, sourceRef, `FieldDiff for ${key} carries sourceUrl`);
  }

  const record = buildTraverseProposalRecord(result, current, sourceRef);
  assert.ok(record.extractionModel.startsWith("traverse:"), "extractionModel tagged as traverse");
  assert.ok(record.overallConfidence >= 0 && record.overallConfidence <= 1, "overallConfidence in 0..1");
  assert.equal((record.rawExtraction as { via: string }).via, "traverse", "rawExtraction preserves traverse audit payload");
  const rawProposals = (record.rawExtraction as { proposals: unknown[] }).proposals;
  assert.equal(rawProposals.length, result.proposals.length, "rawExtraction retains full proposals with verified locators");

  console.log(`✓ healthy source: ${result.proposals.length} verified proposals routed to review path; drop+clamp+provider warnings surfaced`);
}

// ─── 4. Denver rescue: legacy 0 camps, traverse N>0 ────────────────────────

/** Runs the real DenverArtMuseumScraper against a stored fixture (no network). */
class FixtureDenverScraper extends DenverArtMuseumScraper {
  constructor(private readonly fixtureHtml: string) {
    super();
  }
  protected async fetchPage(fetchUrl: string): Promise<ScrapeContext> {
    return { $: cheerio.load(this.fixtureHtml), html: this.fixtureHtml, url: fetchUrl };
  }
}

async function testDenverRescue() {
  const html = loadFixture("denver-art-museum.html");
  const sourceRef = "https://www.denverartmuseum.org/en/summer-camps";
  const prepared = prepareContent(html, "html", 32_000).text ?? "";

  // Legacy selector scraper over the SAME snapshot → 0 camps (stale selectors).
  const legacy = await new FixtureDenverScraper(html).run();
  assert.deepEqual(legacy.errors, [], "legacy scraper fetch/parse should not error on the fixture");
  assert.equal(legacy.camps.length, 0, "legacy DAM selectors must match zero elements on the rebuilt page");

  // Traverse over the same snapshot → rescues the facts.
  const specs: StubProposalSpec[] = [
    { fieldPath: "name", candidateValue: "Young Artists Summer Camp", needle: "Young Artists Summer Camp" },
    { fieldPath: "category", candidateValue: "ARTS", needle: "painting, sculpture, and printmaking" },
    { fieldPath: "ageGroups[].minAge", candidateValue: 7, needle: "Ages 7-11" },
    { fieldPath: "ageGroups[].maxAge", candidateValue: 11, needle: "Ages 7-11" },
    { fieldPath: "schedules[].startDate", candidateValue: "2026-07-14", needle: "July 14-18, 2026" },
    { fieldPath: "pricing[].amount", candidateValue: 385, needle: "$385 per week" },
    { fieldPath: "city", candidateValue: "Denver", needle: "Denver, Colorado" },
    { fieldPath: "applicationUrl", candidateValue: "https://www.denverartmuseum.org/en/summer-camps/young-artists", needle: "Enroll online" },
  ];
  const provider = createStubProvider(specs, { model: "stub-denver" });
  const result = await runTraverseExtraction({ content: html, sourceRef, provider, maxContentChars: 32_000 });

  assert.equal(result.error, undefined, "denver traverse extraction must not error");
  assert.equal(result.proposals.length, specs.length, "traverse rescues all Denver facts the legacy selectors missed");
  assertProvenanceVerified(prepared, result.proposals);

  const changes = traverseProposalsToProposedChanges(result.proposals, {}, sourceRef);
  assert.ok(changes["name"] && changes["name"].new === "Young Artists Summer Camp", "Denver camp name routed to review");
  assert.ok(changes["pricing[].amount"] && changes["pricing[].amount"].new === 385, "Denver price routed to review");

  console.log(`✓ Denver rescue: legacy scraper found 0 camps; traverse produced ${result.proposals.length} verified proposals from the SAME snapshot`);
}

// ─── 5. Per-source isolation on extraction failure ─────────────────────────

async function testExtractionFailureIsolation() {
  const throwingProvider = createStubProvider([], { throwError: "simulated provider blowup" });
  const badResult = await runTraverseExtraction({
    content: "<h1>anything</h1>",
    sourceRef: "https://broken.example.test",
    provider: throwingProvider,
  });
  assert.ok(badResult.error, "a throwing provider must surface as result.error, not an exception");
  assert.deepEqual(badResult.proposals, [], "failed extraction yields no proposals");

  // Sweep: [failing source, healthy source] — the failure must not stop source 2.
  const healthyHtml = loadFixture("avid4-healthy.html");
  const sweep = [
    { ref: "https://broken.example.test", html: "<h1>x</h1>", provider: throwingProvider },
    {
      ref: "https://avid4.com/day-camps/colorado/",
      html: healthyHtml,
      provider: createStubProvider(
        [{ fieldPath: "name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" }],
        { model: "stub-sweep" }
      ),
    },
  ];

  const report: { ref: string; ok: boolean; proposals: number }[] = [];
  for (const src of sweep) {
    // Mirrors scrape-runner's per-source isolation contract: never throws.
    const r = await runTraverseExtraction({ content: src.html, sourceRef: src.ref, provider: src.provider });
    report.push({ ref: src.ref, ok: !r.error, proposals: r.proposals.length });
  }

  assert.equal(report.length, 2, "both sources attempted despite the first failing");
  assert.equal(report[0].ok, false, "source 1 recorded as failed");
  assert.equal(report[1].ok, true, "source 2 after a failure still runs");
  assert.equal(report[1].proposals, 1, "source 2 produced its proposal");

  console.log("✓ extraction failure isolated: throwing provider → result.error (no throw); next source still runs");
}

// ─── Run ────────────────────────────────────────────────────────────────

async function main() {
  await testHealthySourceReplay();
  await testDenverRescue();
  await testExtractionFailureIsolation();
  console.log("\ntraverse replay verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
