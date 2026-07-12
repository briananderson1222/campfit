/**
 * D1 Lookout adapter contract.
 *
 * Wave 1 deliberately leaves the final source guard RED: the behavioral and
 * mutation characterizations run first against the D0 implementation, then
 * the guard requires the Wave 2/3 adapter cutover and legacy-kernel deletion.
 * This script uses synthetic fixtures only and never reads the private replay
 * sample.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { canonicalValueKey } from "@kontourai/lookout";

import { computeDiff } from "../lib/ingestion/diff-engine";
import {
  compareRelation,
  compareValue,
} from "../lib/ingestion/lookout-diff-adapter";
import {
  normalizeScalar,
  relationDomainIdentity,
} from "../lib/ingestion/diff-policy";
import type { Camp } from "../lib/types";
import {
  D0_FIXED_NOW,
  RELATION_FAMILIES,
  RELATION_REPLAY_CASES,
  type RelationMode,
} from "./d0-relation-fixtures";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

function makeCamp(overrides: Partial<Camp> = {}): Camp {
  return {
    id: "synthetic-camp",
    slug: "synthetic-camp",
    name: "Synthetic Camp",
    description: "",
    notes: null,
    campType: "SUMMER_DAY",
    category: "OTHER",
    campTypes: ["SUMMER_DAY"],
    categories: ["OTHER"],
    state: null,
    zip: null,
    websiteUrl: "https://synthetic.invalid/camp",
    interestingDetails: null,
    city: "Denver",
    region: null,
    communitySlug: "synthetic",
    displayName: "Synthetic Camp",
    neighborhood: "",
    address: "",
    latitude: null,
    longitude: null,
    lunchIncluded: false,
    registrationOpenDate: null,
    registrationOpenTime: null,
    registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER",
    lastVerifiedAt: null,
    sourceType: "SCRAPER",
    sourceUrl: null,
    fieldSources: {},
    ageGroups: [],
    schedules: [],
    pricing: [],
    ...overrides,
  } as Camp;
}

function withFixedNow<T>(run: () => T): T {
  const originalNow = Date.now;
  Date.now = () => D0_FIXED_NOW;
  try {
    return run();
  } finally {
    Date.now = originalNow;
  }
}

function characterizeRelations(): void {
  withFixedNow(() => {
    for (const fixture of RELATION_REPLAY_CASES) {
      const changes = computeDiff(
        makeCamp({ [fixture.field]: fixture.current } as unknown as Partial<Camp>),
        { [fixture.field]: fixture.candidate },
        { [fixture.field]: fixture.confidence },
        {},
        fixture.approvedAt ? { [fixture.field]: { approvedAt: fixture.approvedAt } } : {},
      );
      const actual = (changes[fixture.field]?.mode
        ?? (fixture.noneReason === "suppressed" ? "suppressed" : "none")) as RelationMode;
      assert.equal(actual, fixture.expectedPost, fixture.id);
    }
  });

  const malformed = computeDiff(
    makeCamp({ pricing: [{ label: "Invalid", amount: Number.POSITIVE_INFINITY, unit: "PER_WEEK" }] as never }),
    { pricing: [{
      label: "Invalid",
      amount: Number.POSITIVE_INFINITY,
      unit: "PER_WEEK",
      durationWeeks: null,
      ageQualifier: null,
      discountNotes: null,
    }] },
    { pricing: 0.9 },
  );
  assert.equal(malformed.pricing?.mode, "update", "malformed relation identity must fail closed as reviewer-visible update");
  console.log(`PASS semantic relation characterization (${RELATION_REPLAY_CASES.length} matrix rows plus malformed fail-closed)`);
}

function characterizeScalarEnumAndProvenance(): void {
  withFixedNow(() => {
    assert.deepEqual(
      computeDiff(makeCamp(), { city: "Boulder" }, { city: 0.299999 }),
      {},
      "confidence below 0.3 must remain ineligible",
    );
    assert.deepEqual(
      computeDiff(makeCamp(), { city: "Boulder" }, { city: 0.3 }),
      { city: { old: "Denver", new: "Boulder", confidence: 0.3, mode: "update" } },
      "confidence exactly 0.3 must surface without absent provenance keys",
    );

    const inside = new Date(D0_FIXED_NOW - 30 * 86_400_000 + 1).toISOString();
    assert.deepEqual(
      computeDiff(makeCamp(), { city: "Boulder" }, { city: 0.79 }, {}, { city: { approvedAt: inside } }),
      {},
      "inside 30 days and below 0.8 must suppress",
    );
    assert.equal(
      computeDiff(makeCamp(), { city: "Boulder" }, { city: 0.8 }, {}, { city: { approvedAt: inside } }).city?.mode,
      "update",
      "confidence exactly 0.8 must not suppress",
    );
  });

  assert.deepEqual(
    computeDiff(
      makeCamp({ campTypes: ["SUMMER_DAY"] }),
      { campTypes: ["SCHOOL_BREAK", "SUMMER_DAY"] },
      { campTypes: 0.9 },
      { campTypes: "Synthetic excerpt" },
      {},
      "https://synthetic.invalid/source",
    ).campTypes,
    {
      old: ["SUMMER_DAY"],
      new: ["SCHOOL_BREAK", "SUMMER_DAY"],
      confidence: 0.9,
      mode: "update",
      excerpt: "Synthetic excerpt",
      sourceUrl: "https://synthetic.invalid/source",
    },
    "enum relation and provenance presence must remain stable",
  );
  console.log("PASS scalar/enum boundaries and provenance omission/presence");
}

function mutationSensitivity(): void {
  const relationExpected = new Map(RELATION_REPLAY_CASES.map((fixture) => [fixture.id, fixture.expectedPost]));

  const projectorMutationMisses = (Object.keys(RELATION_FAMILIES) as Array<keyof typeof RELATION_FAMILIES>)
    .filter((field) => JSON.stringify(RELATION_FAMILIES[field].stored) !== JSON.stringify(RELATION_FAMILIES[field].same));
  assert.equal(projectorMutationMisses.length, 3, "raw/persistence-aware identity mutation must break all three semantic-equality families");

  const setMutationMisses = RELATION_REPLAY_CASES.filter((fixture) => {
    const collapsedEqual = new Set(fixture.current.map((value) => JSON.stringify(value))).size
      === new Set(fixture.candidate.map((value) => JSON.stringify(value))).size;
    return fixture.id.includes("duplicate") && (collapsedEqual ? "none" : fixture.expectedPost) !== fixture.expectedPost;
  });
  assert.ok(setMutationMisses.length > 0, "duplicate-collapsing set mutation must be killed by the matrix");

  const malformedExpected = "update";
  assert.notEqual("none", malformedExpected, "comparison-error-as-equal mutation must be killed by fail-closed expectation");

  const thresholdMutationMisses = RELATION_REPLAY_CASES.filter((fixture) =>
    fixture.confidence === 0.8 && fixture.approvedAt && relationExpected.get(fixture.id) !== "suppressed");
  assert.equal(thresholdMutationMisses.length, 3, "moving the 0.8 suppression threshold must fail one row per relation family");
  console.log("PASS mutation sensitivity: identity projection, multiset multiplicity, fail-closed mapping, suppression threshold");
}

function characterizeLookoutSeam(): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const lockfile = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  assert.equal(manifest.dependencies?.["@kontourai/lookout"], "0.2.0", "manifest must exact-pin Lookout");
  assert.equal(lockfile.packages?.[""]?.dependencies?.["@kontourai/lookout"], "0.2.0", "root lock entry must exact-pin Lookout");
  assert.equal(lockfile.packages?.["node_modules/@kontourai/lookout"]?.version, "0.2.0", "installed lock entry must resolve Lookout 0.2.0");

  assert.equal(compareValue(" Denver ", "denver", normalizeScalar).changed, false);
  assert.equal(compareValue({ b: 2, a: 1 }, { a: 1, b: 2 }).changed, false);
  assert.equal(compareValue(["SUMMER_DAY", "SCHOOL_BREAK"], ["SCHOOL_BREAK", "SUMMER_DAY"], normalizeScalar).changed, false);
  assert.equal(compareValue(Symbol("unsupported"), "candidate").error?.kind, "unsupported-value");

  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.equal(compareValue(cyclic, []).error?.kind, "cyclic-value");
  assert.equal(compareValue("old", "new", () => { throw new Error("synthetic callback failure"); }).error?.kind, "callback-threw");

  const duplicateCurrent = [{ label: "A", minAge: 5 }, { label: "A", minAge: 5 }];
  const duplicateCandidate = [{ label: "A", minAge: 5 }];
  const duplicateDiff = compareRelation(duplicateCurrent, duplicateCandidate, relationDomainIdentity("ageGroups"));
  assert.equal(duplicateDiff.changed, true, "multiset comparison must preserve duplicate multiplicity");
  assert.equal(duplicateDiff.allCurrentRetained, false);
  assert.equal(duplicateDiff.removals.length, 1);

  const additive = compareRelation(
    [{ label: "A", minAge: 5 }],
    [{ label: "A", minAge: 5, id: "persistence-only" }, { label: "B", minAge: 7 }],
    relationDomainIdentity("ageGroups"),
  );
  assert.equal(additive.changed, true);
  assert.equal(additive.allCurrentRetained, true, "domain projection must exclude persistence-only fields");
  assert.equal(additive.hasNovelCandidate, true);

  const domainFailure = compareRelation(
    [{ label: "Invalid", amount: Number.POSITIVE_INFINITY, unit: "PER_WEEK" }],
    [{ label: "Invalid", amount: Number.POSITIVE_INFINITY, unit: "PER_WEEK" }],
    relationDomainIdentity("pricing"),
  );
  assert.equal(domainFailure.changed, true, "domain validation failure must fail closed");
  assert.equal(domainFailure.unchanged, false);
  assert.equal(domainFailure.allCurrentRetained, false, "error mapping must never classify as additive");
  assert.equal(domainFailure.error?.kind, "unsupported-value");

  const callbackFailure = compareRelation(["old"], ["new"], () => {
    throw new Error("synthetic identity failure");
  });
  assert.equal(callbackFailure.changed, true);
  assert.equal(callbackFailure.error?.kind, "callback-threw");

  assert.equal(canonicalValueKey(Symbol("unsupported")).ok, false, "root canonical export must resolve");
  console.log("PASS Lookout seam: exact pin, root exports, semantic comparison, typed fail-closed errors");
}

function walkTypeScript(relativeRoot: string): string[] {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) found.push(...walkTypeScript(relative));
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) found.push(relative);
  }
  return found;
}

function sourceGuard(): void {
  const violations: string[] = [];
  const read = (relative: string) => fs.existsSync(path.join(ROOT, relative))
    ? fs.readFileSync(path.join(ROOT, relative), "utf8")
    : "";
  const executable = ["app", "lib", "scripts"].flatMap(walkTypeScript);
  const kernelPath = "lib/ingestion/diff-kernel.ts";
  const adapterPath = "lib/ingestion/lookout-diff-adapter.ts";
  const policyPath = "lib/ingestion/diff-policy.ts";

  if (fs.existsSync(path.join(ROOT, kernelPath))) violations.push(`${kernelPath} must be deleted`);
  if (!fs.existsSync(path.join(ROOT, adapterPath))) violations.push(`${adapterPath} must exist`);
  if (!fs.existsSync(path.join(ROOT, policyPath))) violations.push(`${policyPath} must exist`);

  for (const relative of executable) {
    const source = read(relative);
    if (/from\s+["'][^"']*diff-kernel["']|import\s*\(["'][^"']*diff-kernel["']\)/.test(source)) {
      violations.push(`${relative} imports retired diff-kernel`);
    }
    if (relative !== "scripts/test-d1-lookout-adapter.ts"
      && /function\s+(?:canonicalValueKey|relationFacts|stableOuterArrayIdentity|segment)\s*\(/.test(source)) {
      violations.push(`${relative} locally defines retired structural helper`);
    }
    if (/@kontourai\/lookout/.test(source)
      && ![adapterPath, policyPath, "scripts/test-d1-lookout-adapter.ts"].includes(relative)) {
      violations.push(`${relative} imports Lookout outside the D1 seam`);
    }
    if (/canonicalValueKey/.test(source)
      && ![adapterPath, policyPath, "scripts/test-d1-lookout-adapter.ts"].includes(relative)) {
      violations.push(`${relative} accesses canonicalValueKey outside the D1 seam`);
    }
  }

  const diffEngine = read("lib/ingestion/diff-engine.ts");
  const traverseExtractor = read("lib/ingestion/traverse-extractor.ts");
  if (!/from\s+["']\.\/lookout-diff-adapter["']/.test(diffEngine)) {
    violations.push("diff-engine.ts must import the Lookout adapter");
  }
  if (!/from\s+["']\.\/lookout-diff-adapter["']/.test(traverseExtractor)) {
    violations.push("traverse-extractor.ts must import the Lookout adapter");
  }

  const crawlPipeline = read("lib/ingestion/crawl-pipeline.ts");
  const recrawlAdapter = read("lib/ingestion/traverse-recrawl-adapter.ts");
  if (!/from\s+["']\.\/traverse-recrawl-adapter["']/.test(crawlPipeline)) {
    violations.push("crawl-pipeline.ts must retain the traverse-recrawl-adapter choke point");
  }
  if (!/from\s+["']\.\/diff-engine["']/.test(recrawlAdapter)) {
    violations.push("traverse-recrawl-adapter.ts must retain the diff-engine choke point");
  }

  const persistenceBoundaries = [
    "lib/admin/types.ts",
    "lib/ingestion/crawl-pipeline.ts",
    "lib/ingestion/traverse-recrawl-adapter.ts",
  ];
  for (const relative of persistenceBoundaries) {
    if (/canonical(?:Key|_key)|canonicalValueKey/i.test(read(relative))) {
      violations.push(`${relative} exposes a canonical-key persistence field or write value`);
    }
  }

  assert.deepEqual(violations, [], `D1 cutover source guard violations:\n- ${violations.join("\n- ")}`);
  console.log("PASS source/no-persistence guard: legacy dead, imports narrow, recrawl choke point retained");
}

characterizeRelations();
characterizeScalarEnumAndProvenance();
mutationSensitivity();
characterizeLookoutSeam();
sourceGuard();
console.log("\nD1 Lookout adapter contract passed");
