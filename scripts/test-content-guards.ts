/**
 * test-content-guards.ts — regression test for the ingestion content guards
 * added to close audit findings F-10 (editorial "** VERIFY **" marker shipped
 * on the "Dream Big" age field) and F-03 (scrape-artifact camp name
 * "Caresplit … - Now Grasshopper Kids, see that row.").
 *
 * Follows the repo's tsx + node:assert test-script pattern (see
 * scripts/test-ingestion-runner.ts) and is wired into `npm run lint`. Runs
 * without a database: CsvIngestionAdapter.normalize() is pure.
 */

import assert from "node:assert/strict";
import {
  containsEditorialMarker,
  looksLikeArtifactName,
} from "../lib/ingestion/content-guards";
import { CsvIngestionAdapter } from "../lib/ingestion/csv-adapter";

const VERIFY_LABEL =
  "** VERIFY ** Pre-K Kinder & 1st grades 2nd - 5th grades 6th-8th grades 9th - 11th grades";
const CARESPLIT_NAME =
  "Caresplit enrichment camps @ home - Now Grasshopper Kids, see that row.";

function testContainsEditorialMarker() {
  assert.equal(containsEditorialMarker(VERIFY_LABEL), true, "** VERIFY ** must be caught");
  assert.equal(containsEditorialMarker("**TODO** fix ages"), true, "**TODO** must be caught");
  assert.equal(containsEditorialMarker("[[FIXME]]"), true, "[[FIXME]] must be caught");
  // Real copy must not trip the guard.
  assert.equal(containsEditorialMarker("Ages 5-12 · Adventure Day Camp"), false);
  assert.equal(containsEditorialMarker("We verify every camper's registration"), false);
  assert.equal(containsEditorialMarker(null), false);
}

function testLooksLikeArtifactName() {
  assert.equal(looksLikeArtifactName(CARESPLIT_NAME), true, "'see that row.' artifact must be caught");
  assert.equal(looksLikeArtifactName("Something ** VERIFY **"), true, "marker in name must be caught");
  assert.equal(looksLikeArtifactName("Now & Then Nature Camp - see below"), true, "'see below' must be caught");
  // Real camp names must pass.
  assert.equal(looksLikeArtifactName("Apex Music Camp"), false);
  assert.equal(looksLikeArtifactName("Avid4 Adventure"), false);
  assert.equal(looksLikeArtifactName("Cheley Colorado Camps"), false);
  assert.equal(looksLikeArtifactName(null), false);
}

function testAdapterRejectsArtifactName() {
  const adapter = new CsvIngestionAdapter(
    [{ Name: CARESPLIT_NAME, Link: "https://example.test" }],
    "summer"
  );
  assert.throws(
    () => adapter.normalize({ Name: CARESPLIT_NAME, Link: "https://example.test" }),
    /import artifact/,
    "normalize() must reject the scrape-artifact camp name"
  );
}

function testAdapterStripsVerifyAgeLabel() {
  const adapter = new CsvIngestionAdapter(
    [{ Name: "Dream Big", "Ages/Grades": VERIFY_LABEL, Link: "https://example.test" }],
    "summer"
  );
  const camp = adapter.normalize({
    Name: "Dream Big",
    "Ages/Grades": VERIFY_LABEL,
    Link: "https://example.test",
  });
  assert.ok(camp, "a clean-named camp must still import");
  const marked = camp!.ageGroups.filter((ag) => containsEditorialMarker(ag.label));
  assert.deepEqual(marked, [], "no age-group label may contain an editorial marker");
}

function run() {
  const tests = [
    testContainsEditorialMarker,
    testLooksLikeArtifactName,
    testAdapterRejectsArtifactName,
    testAdapterStripsVerifyAgeLabel,
  ];
  for (const t of tests) {
    t();
    process.stdout.write(`  ✓ ${t.name}\n`);
  }
  process.stdout.write(`\ncontent-guards: ${tests.length} tests passed\n`);
}

run();
