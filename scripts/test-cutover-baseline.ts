/**
 * test-cutover-baseline.ts — BEFORE-test for the traverse full cutover
 * (owner directive, 2026-07).
 *
 * Asserts the committed BEFORE baseline (tests/fixtures/cutover-baseline-2026-07.json,
 * produced by `npm run cutover:baseline` while the legacy CSS-selector scrapers
 * still existed — see scripts/cutover-baseline.ts) loads and documents exactly
 * what legacy produced, live, on 2026-07-03:
 *
 *   - avid4: 0 camps (selector-dead — the source the traverse pilot exists to
 *     rescue; see docs/traverse-adjudication-2026-07.md)
 *   - denver-art-museum: 1 camp (selector-dead — same rescue case)
 *   - idtech: 23 camps (the one HEALTHY legacy source; this is the real
 *     regression bar for the cutover — see the >40% rule in
 *     docs/cutover-report-2026-07.md)
 *
 * HISTORICAL RECORD (post-cutover): the legacy scrapers this baseline was
 * measured against (lib/ingestion/scrapers/avid4.ts, denver-arts.ts,
 * idtech.ts) and their BaseScraper harness were DELETED as part of the same
 * cutover that added this test (see docs/cutover-report-2026-07.md) — traverse
 * is now the only ingestion pipeline. This test intentionally asserts against
 * the COMMITTED baseline artifact, not live code or a live fetch, so it keeps
 * passing after that deletion and remains the durable "before" half of the
 * before/after comparison.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const BASELINE_PATH = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "cutover-baseline-2026-07.json"
);

interface BaselineFile {
  generatedAt: string;
  note: string;
  sources: Record<
    string,
    {
      key: string;
      url: string;
      scraperName: string;
      campCount: number;
      legacyErrors: string[];
      fieldCoverage: Record<string, { count: number; fraction: number }>;
      snapshot: { bodyHash: string; status: number; fetchedAt: string; finalUrl: string; bodyChars: number } | null;
      fetchError: string | null;
    }
  >;
}

function loadBaseline(): BaselineFile {
  const raw = fs.readFileSync(BASELINE_PATH, "utf8");
  return JSON.parse(raw) as BaselineFile;
}

function testBaselineLoads() {
  const baseline = loadBaseline();
  assert.ok(baseline.generatedAt, "baseline must record when it was generated");
  assert.ok(baseline.sources, "baseline must have a sources map");
  const keys = Object.keys(baseline.sources).sort();
  assert.deepEqual(
    keys,
    ["avid4", "denver-art-museum", "idtech"],
    "baseline must cover exactly the 3 in-scope sources"
  );
  console.log("✓ baseline file loads and covers avid4, denver-art-museum, idtech");
}

function testDocumentsWhatLegacyProduced() {
  const baseline = loadBaseline();

  const avid4 = baseline.sources["avid4"];
  assert.equal(avid4.campCount, 0, "avid4 legacy baseline: selector-dead, 0 camps");
  assert.ok(avid4.snapshot, "avid4 baseline must reference a captured snapshot");
  assert.equal(avid4.snapshot!.status, 200, "avid4 fetch succeeded (200) even though selectors matched nothing");

  const denver = baseline.sources["denver-art-museum"];
  assert.equal(denver.campCount, 1, "denver-art-museum legacy baseline: selector-dead, 1 camp (page-title fallback)");
  assert.ok(denver.snapshot, "denver baseline must reference a captured snapshot");

  const idtech = baseline.sources["idtech"];
  assert.equal(idtech.campCount, 23, "idtech legacy baseline: HEALTHY source, 23 courses via JSON-LD");
  assert.ok(idtech.snapshot, "idtech baseline must reference a captured snapshot");
  // idtech is the real regression bar (per the owner directive): every course
  // had a name, description, category, websiteUrl, and an age group.
  for (const field of ["name", "description", "category", "websiteUrl", "ageGroups"]) {
    assert.equal(idtech.fieldCoverage[field].count, 23, `idtech baseline: ${field} covered on all 23 legacy camps`);
  }

  console.log(
    `✓ baseline documents legacy output: avid4=${avid4.campCount}, denver-art-museum=${denver.campCount}, idtech=${idtech.campCount} camps`
  );
}

function testEverySourceHasAReplayableSnapshot() {
  const baseline = loadBaseline();
  for (const [key, source] of Object.entries(baseline.sources)) {
    assert.ok(source.snapshot, `${key} baseline must carry a snapshot reference for replay`);
    assert.match(source.snapshot!.bodyHash, /^[0-9a-f]{64}$/, `${key} snapshot bodyHash must be a sha-256 hex digest`);
    assert.ok(source.snapshot!.fetchedAt, `${key} snapshot must record fetchedAt`);
  }
  console.log("✓ every baseline source references a replayable, hash-identified snapshot");
}

function main() {
  testBaselineLoads();
  testDocumentsWhatLegacyProduced();
  testEverySourceHasAReplayableSnapshot();
  console.log("\ncutover baseline verification passed");
}

main();
