/** Genuine parent-vs-worktree, no-review-write Wave D0 exposure replay. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeDiff as postFixComputeDiff } from "../lib/ingestion/diff-engine";
import type { Camp } from "../lib/types";
import {
  CLASSIFIER_OUT_OF_CORPUS,
  D0_FIXED_NOW,
  RELATION_REPLAY_CASES,
  type RelationMode,
  type RelationReplayCase,
} from "./d0-relation-fixtures";

type ComputeDiff = typeof postFixComputeDiff;
interface ParentClassifier {
  computeDiff: ComputeDiff;
  resolvedModulePath: string;
  materializationRoot: string;
  pathUnderMaterializationRoot: boolean;
  pathOutsideWorktree: boolean;
  cleanup: () => void;
}

const PRE_FIX_SHA = execFileSync("git", ["rev-parse", "7cfddde^{}"], { encoding: "utf8" }).trim();
const POST_FIX_SHA = execFileSync("git", ["rev-parse", "HEAD^{}"], { encoding: "utf8" }).trim();
const POST_FIX_DIFF = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
const POST_FIX_DIFF_SHA = execFileSync("git", ["hash-object", "--stdin"], {
  encoding: "utf8",
  input: POST_FIX_DIFF,
}).trim();

function gitShow(sha: string, file: string): string {
  return execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8" });
}

function pathIsUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function materializeParentClassifier(): Promise<ParentClassifier> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "campfit-d0-parent-"));
  const ingestionDir = path.join(root, "lib", "ingestion");
  fs.mkdirSync(ingestionDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  for (const file of ["diff-engine.ts", "diff-kernel.ts"]) {
    fs.writeFileSync(
      path.join(ingestionDir, file),
      gitShow(PRE_FIX_SHA, `lib/ingestion/${file}`),
    );
  }
  const parentModuleUrl = pathToFileURL(path.join(ingestionDir, "diff-engine.ts"));
  const parent = await import(`${parentModuleUrl.href}?sha=${PRE_FIX_SHA}`) as {
    computeDiff: ComputeDiff;
  };
  const resolvedModulePath = fs.realpathSync(fileURLToPath(parentModuleUrl));
  const materializationRoot = fs.realpathSync(root);
  const worktreeRoot = fs.realpathSync(process.cwd());
  const pathUnderMaterializationRoot = pathIsUnder(materializationRoot, resolvedModulePath);
  const pathOutsideWorktree = !pathIsUnder(worktreeRoot, resolvedModulePath);
  if (!pathUnderMaterializationRoot || !pathOutsideWorktree) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(
      `LAUNDERED_REPLAY: parent module path assertion failed: resolved=${resolvedModulePath} ` +
      `underTemp=${pathUnderMaterializationRoot} outsideWorktree=${pathOutsideWorktree}`,
    );
  }
  return {
    computeDiff: parent.computeDiff,
    resolvedModulePath,
    materializationRoot,
    pathUnderMaterializationRoot,
    pathOutsideWorktree,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeCamp(field: RelationReplayCase["field"], items: readonly unknown[]): Camp {
  return {
    id: "camp-id", slug: "camp-a", name: "Camp A", description: "", notes: null,
    campType: "SUMMER_DAY", category: "OTHER", campTypes: ["SUMMER_DAY"], categories: ["OTHER"],
    state: null, zip: null, websiteUrl: "https://example.test/camp-a", interestingDetails: null,
    city: "City A", region: null, communitySlug: "community-a", displayName: "Camp A",
    neighborhood: "", address: "", latitude: null, longitude: null, lunchIncluded: false,
    registrationOpenDate: null, registrationOpenTime: null, registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER", lastVerifiedAt: null, sourceType: "SCRAPER", sourceUrl: null,
    fieldSources: {}, ageGroups: [], schedules: [], pricing: [], [field]: items,
  } as unknown as Camp;
}

function classify(computeDiff: ComputeDiff, fixture: RelationReplayCase): RelationMode {
  const changes = computeDiff(
    makeCamp(fixture.field, fixture.current),
    { [fixture.field]: fixture.candidate },
    { [fixture.field]: fixture.confidence },
    {},
    fixture.approvedAt ? { [fixture.field]: { approvedAt: fixture.approvedAt } } : {},
  );
  return (changes[fixture.field]?.mode ??
    (fixture.noneReason === "suppressed" ? "suppressed" : "none")) as RelationMode;
}

function explain(before: RelationMode, after: RelationMode): { kind: string; text: string } {
  if (before === after) return { kind: "stable", text: `classification stable at ${after}` };
  if (before === "update" && after === "none") {
    return { kind: "false-positive-eliminated", text: "persistence-only identity difference eliminated" };
  }
  if (before === "update" && after === "add_items") {
    return { kind: "additive-reached", text: "retained domain item recognized; only the novel item is additive" };
  }
  if ((before === "none" || before === "suppressed") && !["none", "suppressed"].includes(after)) {
    return { kind: "newly-surfaced", text: `true replay surfaced ${after} from ${before}` };
  }
  if (!["none", "suppressed"].includes(before) && after === "suppressed") {
    return { kind: "newly-suppressed", text: `true replay suppressed prior ${before}` };
  }
  return { kind: "unclassified", text: `unclassified transition ${before}->${after}` };
}

const parent = await materializeParentClassifier();
const sentinel: RelationReplayCase = {
  id: "anti-laundering:persistence-id-false-positive",
  field: "ageGroups",
  current: [{ id: "sentinel-persistence-id", campId: "sentinel-owner", label: "Sentinel", minAge: 5, maxAge: 7, minGrade: null, maxGrade: null }],
  candidate: [{ label: "Sentinel", minAge: 5, maxAge: 7, minGrade: null, maxGrade: null }],
  confidence: 0.9,
  noneReason: "equality",
  bucket: "anti-laundering-sentinel",
  expectedPost: "none",
  fixtureRefs: ["scripts/d0-review-noise-report.ts"],
};
const sentinelParentMode = classify(parent.computeDiff, sentinel);
const sentinelPostFixMode = classify(postFixComputeDiff, sentinel);
if (sentinelParentMode === sentinelPostFixMode || sentinelParentMode !== "update" || sentinelPostFixMode !== "none") {
  parent.cleanup();
  throw new Error(
    `LAUNDERED_REPLAY: sentinel divergence missing: parent=${sentinelParentMode} postFix=${sentinelPostFixMode}`,
  );
}
const originalNow = Date.now;
Date.now = () => D0_FIXED_NOW;
let rows: Array<RelationReplayCase & { before: RelationMode; after: RelationMode; explanation: ReturnType<typeof explain> }>;
try {
  rows = RELATION_REPLAY_CASES.map((fixture) => {
    const before = classify(parent.computeDiff, fixture);
    const after = classify(postFixComputeDiff, fixture);
    assert.equal(after, fixture.expectedPost, `${fixture.id}: post-fix fixture expectation drifted`);
    return { ...fixture, before, after, explanation: explain(before, after) };
  });
} finally {
  Date.now = originalNow;
  parent.cleanup();
}

const isProposal = (mode: RelationMode) => ["populate", "update", "add_items"].includes(mode);
const newlySurfaced = rows.filter((row) => !isProposal(row.before) && isProposal(row.after));
const grouped = rows.reduce<Record<string, { cases: number; before: number; after: number; transitions: Record<string, number> }>>(
  (result, row) => {
    const key = `${row.field}|${row.bucket}`;
    const group = result[key] ?? { cases: 0, before: 0, after: 0, transitions: {} };
    group.cases += 1;
    if (isProposal(row.before)) group.before += 1;
    if (isProposal(row.after)) group.after += 1;
    const transition = `${row.before}->${row.after}`;
    group.transitions[transition] = (group.transitions[transition] ?? 0) + 1;
    result[key] = group;
    return result;
  },
  {},
);
const summary = {
  preFixSha: PRE_FIX_SHA,
  postFixSha: POST_FIX_SHA,
  postFixWorktreeDiffSha: POST_FIX_DIFF_SHA,
  postFixIncludesUncommittedWorktree: POST_FIX_DIFF.length > 0,
  materializedParentModules: ["lib/ingestion/diff-engine.ts", "lib/ingestion/diff-kernel.ts"],
  corpusModule: "scripts/d0-relation-fixtures.ts",
  fixtureModules: ["scripts/test-recrawl-adapter.ts", "scripts/test-d0-identity-hydration.ts"],
  fixtures: rows.length,
  beforeProposals: rows.filter((row) => isProposal(row.before)).length,
  afterProposals: rows.filter((row) => isProposal(row.after)).length,
  newlySurfaced: newlySurfaced.length,
  newlySuppressed: rows.filter((row) => isProposal(row.before) && row.after === "suppressed").length,
  eliminatedFalsePositives: rows.filter((row) => isProposal(row.before) && row.after === "none").length,
  intentionalModeCorrections: rows.filter((row) => isProposal(row.before) && isProposal(row.after) && row.before !== row.after).length,
  unexplainedNewlySurfaced: newlySurfaced.filter((row) => row.explanation.kind === "unclassified").length,
  threshold: "zero unexplained newly surfaced proposals",
  persistentWrites: 0,
  temporaryMaterializationFiles: 3,
  productionSampleExtension: "NOT_VERIFIED — owner-gated later",
  guards: {
    parentModulePath: {
      resolved: parent.resolvedModulePath,
      underTempMaterialization: parent.pathUnderMaterializationRoot,
      outsideWorktree: parent.pathOutsideWorktree,
      verdict: "PASS",
    },
    sentinelDivergence: {
      id: sentinel.id,
      parent: sentinelParentMode,
      postFix: sentinelPostFixMode,
      verdict: "PASS",
    },
  },
};
const thresholdVerdict = summary.unexplainedNewlySurfaced === 0 ? "PASS" : "FAIL";

assert.equal(thresholdVerdict, "PASS");
console.log(`GUARD parent-module-path underTemp=${parent.pathUnderMaterializationRoot} outsideWorktree=${parent.pathOutsideWorktree} PASS`);
console.log(`GUARD sentinel-divergence parent=${sentinelParentMode} postFix=${sentinelPostFixMode} PASS`);
console.log("D0 GENUINE PARENT-VS-WORKTREE NO-WRITE REVIEW-NOISE REPORT");
for (const row of rows) {
  console.log(JSON.stringify({
    id: row.id,
    field: row.field,
    bucket: row.bucket,
    fixtureRefs: row.fixtureRefs,
    before: row.before,
    after: row.after,
    explanation: row.explanation,
  }));
}
console.log(`GROUPED ${JSON.stringify(grouped)}`);
console.log(`OUT_OF_CORPUS ${JSON.stringify(CLASSIFIER_OUT_OF_CORPUS)}`);
console.log(`SUMMARY ${JSON.stringify({ ...summary, thresholdVerdict })}`);
