/**
 * test-traverse-replay.ts — REPLAY-mode proof for the traverse FULL CUTOVER
 * (owner directive, 2026-07). No network, no API key: a deterministic stub
 * provider runs traverse extraction over stored HTML snapshots and asserts
 * the pipeline plumbing end-to-end, including the per-item grouping engine
 * this cutover adds (traverse-item-grouping.ts) and the pipeline that
 * replaces the old flagged/shadow ingestion path (traverse-pipeline.ts).
 *
 * Snapshots (tests/fixtures/traverse/):
 *  - avid4-healthy.html       — single-item page (no indices needed).
 *  - avid4-multi-item.html    — TWO camps + an unrelated decoy age blurb;
 *                               the per-item / per-band grouping proof.
 *  - denver-art-museum.html   — a real rebuilt page traverse still reads
 *                               correctly (the source's CSS selectors were
 *                               already dead; see docs/cutover-report-2026-07.md
 *                               for the retired legacy comparison).
 *
 * Asserts:
 *  1. Per-item grouping via REAL traverse 0.4.0 pathIndices normalization:
 *     two items on one page, with fully-indexed nested arrays, group into
 *     two separate records with NO cross-item / cross-band mixing — proving
 *     the adjudicated stitching bug (docs/traverse-adjudication-2026-07.md)
 *     is structurally closed, not just less likely.
 *  2. The positional-pairing fallback for an un-indexed nested array within
 *     one item still keeps two age bands separate (paired in encounter
 *     order) and records a warning — degraded, but never cross-item.
 *  3. Provenance is real (excerpt verified + locator derived) and nothing is
 *     dropped/clamped silently.
 *  4. Proposals route into the review path in the RELATIONS-compatible
 *     shape (`ageGroups`/`schedules`/`pricing` as bare keys, each holding a
 *     full array of reconstructed rows) — the pilot's old
 *     `"ageGroups[].minAge"`-keyed diffs were inert on approve; this shape
 *     isn't.
 *  5. Snapshot replay is byte-identical AND re-running the same stub
 *     provider over the replayed snapshot reproduces the identical grouped
 *     items (plumbing determinism).
 *  6. Per-source failure isolation at the PIPELINE level: one source's
 *     fetch/extraction failure never throws and never stops the next
 *     source in a sweep — every source goes through the same path now
 *     (no more rotted/healthy split).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { prepareContent } from "@kontourai/traverse";
import type { ExtractionProposal } from "@kontourai/traverse";
import {
  runTraverseExtraction,
  itemToProposedChanges,
  buildTraverseItemProposalRecords,
} from "../lib/ingestion/traverse-extractor";
import { assembleItems } from "../lib/ingestion/traverse-item-grouping";
import { createStubProvider, StubProposalSpec } from "../tests/fixtures/traverse/stub-provider";
import {
  runTraversePipelineForSource,
  runTraversePipeline,
  type TraverseProposalSink,
} from "../lib/ingestion/traverse-pipeline";
import {
  createInMemorySnapshotStore,
  replaySource,
  type FetchLike,
} from "@kontourai/traverse/fetch";

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
function assertProvenanceVerified(prepared: string, proposals: ExtractionProposal[]) {
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

// ─── 1. Per-item + per-band grouping via REAL pathIndices normalization ───

async function testMultiItemGrouping() {
  const html = loadFixture("avid4-multi-item.html");
  const sourceRef = "https://avid4.com/day-camps/colorado/";

  // Deliberately out of item/field order, to prove grouping depends on
  // pathIndices, not emission order. Every nested array is FULLY indexed
  // (both items[N] and ageGroups[M]/schedules[M]/pricing[M]), so extract()'s
  // normalization strips two levels and records pathIndices: [item, sub].
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[1].name", candidateValue: "Junior Rangers Day Camp", needle: "Junior Rangers Day Camp" },
    { fieldPath: "items[0].ageGroups[0].maxAge", candidateValue: 12, needle: "Ages 6-12" },
    { fieldPath: "items[0].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[1].ageGroups[0].minAge", candidateValue: 8, needle: "Ages 8-14" },
    { fieldPath: "items[0].ageGroups[0].minAge", candidateValue: 6, needle: "Ages 6-12" },
    { fieldPath: "items[1].ageGroups[0].maxAge", candidateValue: 14, needle: "Ages 8-14" },
    { fieldPath: "items[0].schedules[0].startDate", candidateValue: "2026-06-09", needle: "June 9-13, 2026" },
    { fieldPath: "items[0].schedules[0].endDate", candidateValue: "2026-06-13", needle: "June 9-13, 2026" },
    { fieldPath: "items[1].schedules[0].startDate", candidateValue: "2026-07-07", needle: "July 7-11, 2026" },
    { fieldPath: "items[1].schedules[0].endDate", candidateValue: "2026-07-11", needle: "July 7-11, 2026" },
    { fieldPath: "items[0].pricing[0].amount", candidateValue: 425, needle: "$425 per week" },
    { fieldPath: "items[1].pricing[0].amount", candidateValue: 450, needle: "$450 per week" },
  ];

  const provider = createStubProvider(specs, { model: "stub-multi-item" });
  const result = await runTraverseExtraction({ content: html, sourceRef, provider, maxContentChars: 32_000 });

  assert.equal(result.error, undefined, "multi-item extraction must not error");
  assert.equal(result.proposals.length, specs.length, "every indexed proposal must survive normalization + verification");
  assert.ok(
    result.proposals.every((p) => p.pathIndices !== undefined),
    "every proposal here used an indexed source path, so pathIndices must be set by REAL traverse normalization"
  );
  assert.ok(
    result.proposals.every((p) => !p.fieldPath.includes("[0]") && !p.fieldPath.includes("[1]")),
    "normalized fieldPath must be rewritten to the declared un-indexed items[]/ageGroups[]/etc. form"
  );

  const items = assembleItems(result.proposals);
  assert.equal(items.length, 2, "two source items must group into two AssembledItem records");

  const [item0, item1] = items;
  assert.equal(item0.itemIndex, 0);
  assert.equal(item1.itemIndex, 1);
  assert.equal(item0.scalars.name?.candidateValue, "Mountain Explorers Day Camp");
  assert.equal(item1.scalars.name?.candidateValue, "Junior Rangers Day Camp");

  // The critical anti-stitching assertion: item0's age band is EXACTLY
  // {6,12} (never touched by item1's 8/14), and vice versa.
  assert.deepEqual(
    item0.ageGroups.map((ag) => [ag.minAge, ag.maxAge]),
    [[6, 12]],
    "item0 age band must be its own (6-12), not stitched with item1's"
  );
  assert.deepEqual(
    item1.ageGroups.map((ag) => [ag.minAge, ag.maxAge]),
    [[8, 14]],
    "item1 age band must be its own (8-14), not stitched with item0's"
  );
  assert.deepEqual(item0.schedules.map((s) => [s.startDate, s.endDate]), [["2026-06-09", "2026-06-13"]]);
  assert.deepEqual(item1.schedules.map((s) => [s.startDate, s.endDate]), [["2026-07-07", "2026-07-11"]]);
  assert.deepEqual(item0.pricing.map((p) => p.amount), [425]);
  assert.deepEqual(item1.pricing.map((p) => p.amount), [450]);

  // The page's decoy "Ages 15-17" teen blurb was never proposed by the stub
  // (mirroring a well-behaved model that only grounds items it actually
  // enumerated) and so appears in NEITHER item — no cross-item leakage.
  const allAges = [...item0.ageGroups, ...item1.ageGroups].flatMap((ag) => [ag.minAge, ag.maxAge]);
  assert.ok(!allAges.includes(15) && !allAges.includes(17), "the unrelated decoy age band must not leak into either item");

  console.log("✓ multi-item grouping: 2 items, each age/date/price band correctly scoped to its own item (no cross-band stitching)");
}

// ─── 1b. Cross-CHUNK item-index rebasing (traverse 0.5.0+ chunking) ──────

/**
 * Builds a synthetic ExtractionProposal directly (bypassing extract()/a
 * stub provider) — assembleItems() only reads fieldPath/pathIndices/
 * provenance/candidateValue/confidence/extractor, so this is sufficient to
 * exercise its grouping logic against exactly the shape a chunked
 * traverse 0.5.0+ result produces: raw pathIndices[0] restarting at 0 per
 * chunk, with `locator` still monotonically anchored to the shared
 * `fullText` (see traverse's extract.js normalizeChunkProposals).
 */
function proposal(
  fieldPath: string,
  candidateValue: unknown,
  pathIndices: number[] | undefined,
  locatorStart: number,
  excerptLen = 5
): ExtractionProposal {
  return {
    fieldPath,
    candidateValue,
    confidence: 0.9,
    provenance: { excerpt: "x".repeat(excerptLen), locator: `chars:${locatorStart}-${locatorStart + excerptLen}` },
    extractor: "test",
    ...(pathIndices ? { pathIndices } : {}),
  };
}

async function testCrossChunkItemIndexRebase() {
  // Simulates a REAL observed shape (live idtech run, 2026-07): two chunks,
  // each numbering items[0..N] from 0 again, but with monotonically
  // increasing `locator` offsets into the shared fullText (chunk 2's card
  // content is later in the document than chunk 1's, even though its own
  // item numbering restarts).
  const proposals: ExtractionProposal[] = [
    // chunk 1: items 0 and 1, locators 0-99
    proposal("items[].name", "Course A", [0], 10),
    proposal("items[].ageGroups[].minAge", 7, [0, 0], 20),
    proposal("items[].name", "Course B", [1], 40),
    proposal("items[].ageGroups[].minAge", 8, [1, 0], 50),
    // chunk 2: items 0 and 1 again, but locators are HIGHER (later document
    // position) — this is the discriminator vs. genuine same-chunk
    // out-of-order emission (see testMultiItemGrouping), which would move
    // the locator BACKWARD together with the index.
    proposal("items[].name", "Course C", [0], 500),
    proposal("items[].ageGroups[].minAge", 9, [0, 0], 510),
    proposal("items[].name", "Course D", [1], 540),
    proposal("items[].ageGroups[].minAge", 10, [1, 0], 550),
  ];

  const items = assembleItems(proposals);
  assert.equal(items.length, 4, "4 real courses across 2 chunks must assemble into 4 items, not collide down to 2");

  const names = items.map((i) => i.scalars.name?.candidateValue);
  assert.deepEqual(names, ["Course A", "Course B", "Course C", "Course D"], "each course keeps its own name — no cross-chunk merge");

  const ages = items.map((i) => i.ageGroups[0]?.minAge);
  assert.deepEqual(ages, [7, 8, 9, 10], "each course keeps its own age band — no cross-chunk field stitching");

  assert.deepEqual(items.map((i) => i.itemIndex), [0, 1, 2, 3], "rebased item indices are contiguous across the chunk boundary");

  assert.deepEqual(items[0].warnings, [], "the first chunk's items carry no rebase warning");
  assert.deepEqual(items[1].warnings, [], "the first chunk's items carry no rebase warning");
  assert.ok(
    items[2].warnings.some((w) => w.includes("rebased across a traverse chunk boundary")),
    "the first item of the second chunk must record the rebase as a visible warning"
  );
  assert.deepEqual(items[3].warnings, [], "only the FIRST item of a new chunk carries the boundary warning, not every item after it");

  console.log("✓ cross-chunk item-index rebasing: 2 chunks' colliding pathIndices[0] resolve to 4 distinct items via locator-disambiguated rebasing, with a visible boundary warning");
}

async function testSameChunkOutOfOrderIsNotMistakenForAChunkBoundary() {
  // The mirror-image case: index AND locator both move BACKWARD together
  // (revisiting an earlier item within the SAME chunk, exactly what
  // testMultiItemGrouping already proves end-to-end via real traverse
  // normalization) must NOT be rebased — this directly guards against an
  // overzealous chunk-boundary heuristic.
  const proposals: ExtractionProposal[] = [
    proposal("items[].name", "Course B", [1], 200),
    proposal("items[].name", "Course A", [0], 50), // index AND locator both go backward
    proposal("items[].ageGroups[].minAge", 8, [1, 0], 250),
    proposal("items[].ageGroups[].minAge", 7, [0, 0], 60),
  ];

  const items = assembleItems(proposals);
  assert.equal(items.length, 2, "an out-of-order same-chunk emission must still assemble into exactly 2 items");
  assert.equal(items[0].scalars.name?.candidateValue, "Course A");
  assert.equal(items[1].scalars.name?.candidateValue, "Course B");
  assert.deepEqual(items[0].warnings, [], "no chunk-boundary warning for a same-chunk out-of-order emission");
  assert.deepEqual(items[1].warnings, [], "no chunk-boundary warning for a same-chunk out-of-order emission");

  console.log("✓ same-chunk out-of-order emission (index AND locator both move backward together) is correctly NOT mistaken for a chunk boundary");
}

// ─── 2. Positional-pairing fallback for an un-indexed nested array ───────

async function testPositionalPairingFallback() {
  const html = loadFixture("avid4-multi-item.html");
  const sourceRef = "https://avid4.com/day-camps/colorado/";

  // items[0] is indexed, but its ageGroups[] entries are NOT (a provider
  // that indexes the outer item but not a singleton-seeming inner array) —
  // pathIndices will be [0] only (length 1), so assembleItems must fall
  // back to positional pairing of minAge/maxAge in encounter order, and it
  // must record a warning about the degraded (but still item-scoped) path.
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[0].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[0].ageGroups[].minAge", candidateValue: 6, needle: "Ages 6-12" },
    { fieldPath: "items[0].ageGroups[].maxAge", candidateValue: 12, needle: "Ages 6-12" },
    { fieldPath: "items[0].ageGroups[].minAge", candidateValue: 8, needle: "Ages 8-14" },
    { fieldPath: "items[0].ageGroups[].maxAge", candidateValue: 14, needle: "Ages 8-14" },
  ];
  const provider = createStubProvider(specs, { model: "stub-positional" });
  const result = await runTraverseExtraction({ content: html, sourceRef, provider, maxContentChars: 32_000 });

  assert.equal(result.error, undefined);
  assert.equal(result.proposals.length, specs.length);
  assert.ok(
    result.proposals.filter((p) => p.fieldPath === "ageGroups[].minAge" || p.fieldPath === "ageGroups[].maxAge")
      .every((p) => (p.pathIndices?.length ?? 0) <= 1),
    "un-indexed nested proposals must carry at most the outer item index"
  );

  const items = assembleItems(result.proposals);
  assert.equal(items.length, 1);
  assert.deepEqual(
    items[0].ageGroups.map((ag) => [ag.minAge, ag.maxAge]),
    [[6, 12], [8, 14]],
    "un-indexed minAge/maxAge pairs must still pair by encounter order (1st with 1st, 2nd with 2nd)"
  );
  assert.ok(
    items[0].warnings.some((w) => w.includes("paired") && w.includes("positionally")),
    "the positional-pairing fallback must be recorded as a warning, not silent"
  );

  console.log("✓ positional-pairing fallback: un-indexed age bands within one item still pair correctly, with a recorded warning");
}

// ─── 3. Provenance + warnings (single-item page, no indices needed) ──────

async function testHealthySourceReplay() {
  const html = loadFixture("avid4-healthy.html");
  const sourceRef = "https://avid4.com/day-camps/colorado/";
  const prepared = prepareContent(html, "html", 32_000).text ?? "";

  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[].category", candidateValue: "NATURE", needle: "hiking, climbing, and paddling" },
    { fieldPath: "items[].applicationUrl", candidateValue: "https://avid4.com/register/mountain-explorers", needle: "Register now" },
    { fieldPath: "items[].ageGroups[].minAge", candidateValue: 6, needle: "Ages 6-12" },
    { fieldPath: "items[].ageGroups[].maxAge", candidateValue: 12, needle: "Ages 6-12" },
    { fieldPath: "items[].schedules[].startDate", candidateValue: "2026-06-09", needle: "June 9-13, 2026" },
    { fieldPath: "items[].pricing[].amount", candidateValue: 425, needle: "$425 per week" },
    // Out-of-range confidence → clamped to 1 with a warning (never dropped).
    { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder, Colorado", confidence: 1.4 },
    // Excerpt not present in prepared text → dropped with a warning.
    { fieldPath: "items[].neighborhood", candidateValue: "Highlands", needle: "THIS PHRASE IS NOT ON THE PAGE" },
  ];

  const provider = createStubProvider(specs, {
    model: "stub-1",
    warnings: ["provider-side: sample truncation note"],
  });

  const result = await runTraverseExtraction({ content: html, sourceRef, provider, maxContentChars: 32_000 });

  assert.equal(result.error, undefined, "healthy extraction must not error");
  assert.equal(result.proposals.length, 8, "8 of 9 stub proposals should survive normalization");
  assert.ok(!result.proposals.some((p) => p.fieldPath === "neighborhood"), "the not-found-excerpt proposal must be dropped");
  assert.ok(
    result.proposals.every((p) => p.pathIndices === undefined),
    "un-indexed items[] paths (a single-item page) need no pathIndices — item 0 by default"
  );

  assertProvenanceVerified(prepared, result.proposals);
  assert.ok(result.proposals.every((p) => LOCATOR_RE.test(p.provenance.locator)));

  const warnings = result.warnings ?? [];
  assert.ok(warnings.some((w) => w.includes("excerpt not found in prepared content")));
  assert.ok(warnings.some((w) => w.includes("clamped out-of-range confidence") && w.includes("city")));
  assert.ok(warnings.some((w) => w.includes("provider-side: sample truncation note")));

  const items = assembleItems(result.proposals);
  assert.equal(items.length, 1, "a single-item page (no pathIndices) must default to item 0");
  assert.equal(items[0].scalars.city?.confidence, 1, "out-of-range 1.4 confidence must clamp to 1");

  // Routed into the review path — scalar diff + RELATIONS-shaped array diffs.
  const current = { name: "Avid4 Adventure Camp", city: "" };
  const changes = itemToProposedChanges(items[0], current, sourceRef);
  assert.ok(changes["name"], "scalar 'name' change routed");
  assert.equal(changes["name"].new, "Mountain Explorers Day Camp");
  assert.equal(changes["name"].mode, "update");
  assert.equal(changes["city"].mode, "populate", "empty current city → populate");
  assert.ok(Array.isArray(changes["ageGroups"]?.new), "ageGroups routed as a bare-key array (RELATIONS-compatible)");
  assert.deepEqual((changes["ageGroups"].new as { minAge: number; maxAge: number }[])[0], {
    label: "Ages 6-12",
    minAge: 6,
    maxAge: 12,
    minGrade: null,
    maxGrade: null,
  });
  assert.ok(Array.isArray(changes["schedules"]?.new));
  assert.ok(Array.isArray(changes["pricing"]?.new));
  for (const key of Object.keys(changes)) {
    assert.ok(typeof changes[key].excerpt === "string" && changes[key].excerpt!.length > 0, `FieldDiff for ${key} carries an excerpt`);
    assert.equal(changes[key].sourceUrl, sourceRef, `FieldDiff for ${key} carries sourceUrl`);
  }

  const records = buildTraverseItemProposalRecords(result, { sourceUrl: sourceRef });
  assert.equal(records.length, 1);
  assert.ok(records[0].extractionModel.startsWith("traverse:"));
  assert.ok(records[0].overallConfidence >= 0 && records[0].overallConfidence <= 1);
  assert.equal((records[0].rawExtraction as { via: string }).via, "traverse");

  console.log(`✓ healthy single-item source: ${result.proposals.length} verified proposals routed to review path (RELATIONS-shaped arrays); drop+clamp+provider warnings surfaced`);
}

// ─── 4. Real page, traverse still reads it (legacy comparison retired) ───

async function testDenverPageExtraction() {
  const html = loadFixture("denver-art-museum.html");
  const sourceRef = "https://www.denverartmuseum.org/en/summer-camps";
  const prepared = prepareContent(html, "html", 32_000).text ?? "";

  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Young Artists Summer Camp", needle: "Young Artists Summer Camp" },
    { fieldPath: "items[].category", candidateValue: "ARTS", needle: "painting, sculpture, and printmaking" },
    { fieldPath: "items[].ageGroups[].minAge", candidateValue: 7, needle: "Ages 7-11" },
    { fieldPath: "items[].ageGroups[].maxAge", candidateValue: 11, needle: "Ages 7-11" },
    { fieldPath: "items[].schedules[].startDate", candidateValue: "2026-07-14", needle: "July 14-18, 2026" },
    { fieldPath: "items[].pricing[].amount", candidateValue: 385, needle: "$385 per week" },
    { fieldPath: "items[].city", candidateValue: "Denver", needle: "Denver, Colorado" },
    { fieldPath: "items[].applicationUrl", candidateValue: "https://www.denverartmuseum.org/en/summer-camps/young-artists", needle: "Enroll online" },
  ];
  const provider = createStubProvider(specs, { model: "stub-denver" });
  const result = await runTraverseExtraction({ content: html, sourceRef, provider, maxContentChars: 32_000 });

  assert.equal(result.error, undefined);
  assert.equal(result.proposals.length, specs.length);
  assertProvenanceVerified(prepared, result.proposals);

  const items = assembleItems(result.proposals);
  const changes = itemToProposedChanges(items[0], {}, sourceRef);
  assert.ok(changes["name"] && changes["name"].new === "Young Artists Summer Camp");
  assert.ok(Array.isArray(changes["pricing"]?.new) && (changes["pricing"].new as { amount: number }[])[0].amount === 385);

  console.log(`✓ Denver page: traverse produced ${result.proposals.length} verified proposals, routed with RELATIONS-shaped arrays`);
}

// ─── 5. Per-source isolation on extraction failure (extract() level) ─────

async function testExtractionFailureIsolation() {
  const throwingProvider = createStubProvider([], { throwError: "simulated provider blowup" });
  const badResult = await runTraverseExtraction({
    content: "<h1>anything</h1>",
    sourceRef: "https://broken.example.test",
    provider: throwingProvider,
  });
  assert.ok(badResult.error, "a throwing provider must surface as result.error, not an exception");
  assert.deepEqual(badResult.proposals, []);

  const healthyHtml = loadFixture("avid4-healthy.html");
  const sweep = [
    { ref: "https://broken.example.test", html: "<h1>x</h1>", provider: throwingProvider },
    {
      ref: "https://avid4.com/day-camps/colorado/",
      html: healthyHtml,
      provider: createStubProvider(
        [{ fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" }],
        { model: "stub-sweep" }
      ),
    },
  ];

  const report: { ref: string; ok: boolean; proposals: number }[] = [];
  for (const src of sweep) {
    const r = await runTraverseExtraction({ content: src.html, sourceRef: src.ref, provider: src.provider });
    report.push({ ref: src.ref, ok: !r.error, proposals: r.proposals.length });
  }

  assert.equal(report[0].ok, false, "source 1 recorded as failed");
  assert.equal(report[1].ok, true, "source 2 after a failure still runs");
  assert.equal(report[1].proposals, 1);

  console.log("✓ extraction failure isolated: throwing provider → result.error (no throw); next source still runs");
}

// ─── 6. Snapshot replay determinism + pipeline-level failure isolation ───

function makeFixtureFetch(html: string, status = 200): FetchLike {
  return async (fetchUrl: string) => {
    const isRobots = fetchUrl.endsWith("/robots.txt");
    return {
      status: isRobots ? 200 : status,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === "content-type"
            ? isRobots
              ? "text/plain"
              : "text/html; charset=utf-8"
            : null,
      },
      text: async () => (isRobots ? "User-agent: *\nDisallow:" : html),
    };
  };
}

async function testSnapshotReplayDeterminism() {
  const html = loadFixture("avid4-healthy.html");
  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" },
    { fieldPath: "items[].ageGroups[].minAge", candidateValue: 6, needle: "Ages 6-12" },
    { fieldPath: "items[].ageGroups[].maxAge", candidateValue: 12, needle: "Ages 6-12" },
  ];
  const store = createInMemorySnapshotStore();
  const captured: string[] = [];
  const sink: TraverseProposalSink = async (record) => {
    captured.push(JSON.stringify(record.proposedChanges));
    return `proposal-${captured.length}`;
  };

  const liveResult = await runTraversePipelineForSource(
    { key: "avid4", name: "Avid4 Adventure", url: "https://avid4.com/day-camps/colorado/" },
    {
      provider: createStubProvider(specs, { model: "stub-replay" }),
      store,
      sink,
      mode: "live-with-capture",
      fetchOptions: { fetch: makeFixtureFetch(html), sleep: async () => {} },
      log: () => {},
    }
  );
  assert.equal(liveResult.ok, true);
  assert.equal(liveResult.itemCount, 1);
  assert.ok(liveResult.snapshotBodyHash);

  // Replay: no network at all — fetchOptions.fetch would throw if ever called.
  const throwingFetch: FetchLike = async () => {
    throw new Error("network must not be reached in replay mode");
  };
  const replayResult = await runTraversePipelineForSource(
    { key: "avid4", name: "Avid4 Adventure", url: "https://avid4.com/day-camps/colorado/" },
    {
      provider: createStubProvider(specs, { model: "stub-replay" }),
      store,
      sink,
      mode: "replay",
      fetchOptions: { fetch: throwingFetch, sleep: async () => {} },
      log: () => {},
    }
  );

  assert.equal(replayResult.ok, true, "replay must succeed with no network");
  assert.equal(replayResult.snapshotBodyHash, liveResult.snapshotBodyHash, "replayed snapshot must be byte-identical");
  assert.equal(replayResult.itemCount, liveResult.itemCount, "replay must reproduce the same item grouping");
  assert.equal(
    captured[1],
    captured[0],
    "re-running the same stub provider over the replayed snapshot must produce IDENTICAL proposedChanges (plumbing determinism)"
  );

  const replayCheck = await replaySource(store, "avid4");
  assert.ok(replayCheck.snapshot?.fromCache);
  assert.equal(replayCheck.snapshot?.body, html);

  console.log("✓ snapshot replay: byte-identical bytes, no network touched, identical grouped proposals reproduced");
}

async function testPipelineFailureIsolation() {
  const healthyHtml = loadFixture("avid4-healthy.html");
  const store = createInMemorySnapshotStore();
  const routed: string[] = [];
  const sink: TraverseProposalSink = async (record) => {
    routed.push(record.itemName);
    return `proposal-${routed.length}`;
  };

  const results = await runTraversePipeline(
    [
      { key: "dead-source", name: "Dead Source", url: "https://dead.example.test/camps" },
      { key: "avid4", name: "Avid4 Adventure", url: "https://avid4.com/day-camps/colorado/" },
    ],
    {
      provider: createStubProvider(
        [{ fieldPath: "items[].name", candidateValue: "Mountain Explorers Day Camp", needle: "Mountain Explorers Day Camp" }],
        { model: "stub-pipeline-sweep" }
      ),
      store,
      sink,
      mode: "live-with-capture",
      fetchOptions: {
        // The dead source 404s; avid4 serves real HTML — a single FetchLike
        // routes by URL so both sources share one injected fetch.
        fetch: (async (fetchUrl: string, init: Parameters<FetchLike>[1]) => {
          if (fetchUrl.includes("dead.example.test")) {
            const isRobots = fetchUrl.endsWith("/robots.txt");
            return {
              status: isRobots ? 200 : 404,
              headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/plain" : null) },
              text: async () => (isRobots ? "User-agent: *\nDisallow:" : "Not Found"),
            };
          }
          return makeFixtureFetch(healthyHtml)(fetchUrl, init);
        }) as FetchLike,
        sleep: async () => {},
      },
      log: () => {},
    }
  );

  assert.equal(results.length, 2, "both sources attempted despite the first failing");
  assert.equal(results[0].ok, false, "dead-source recorded as failed (never throws)");
  assert.match(results[0].fetchError ?? "", /http-error/);
  assert.equal(results[1].ok, true, "avid4 after a failure still runs — no more rotted/healthy split, every source shares one path");
  assert.equal(results[1].itemCount, 1);
  assert.deepEqual(routed, ["Mountain Explorers Day Camp"], "only the healthy source's item reached the sink");

  console.log("✓ pipeline-level isolation: a dead source's fetch failure never throws and never stops the next source");
}

// ─── Run ────────────────────────────────────────────────────────────────

async function main() {
  await testMultiItemGrouping();
  await testCrossChunkItemIndexRebase();
  await testSameChunkOutOfOrderIsNotMistakenForAChunkBoundary();
  await testPositionalPairingFallback();
  await testHealthySourceReplay();
  await testDenverPageExtraction();
  await testExtractionFailureIsolation();
  await testSnapshotReplayDeterminism();
  await testPipelineFailureIsolation();
  console.log("\ntraverse replay verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
