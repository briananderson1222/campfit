/** Read-only private-corpus replay. Output is aggregate-only and identifier-free. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtractionProposal } from "@kontourai/traverse";
import { computeDiff as currentComputeDiff } from "../lib/ingestion/diff-engine";
import { assembleItems } from "../lib/ingestion/traverse-item-grouping";
import { assembledItemToDiffInputs } from "../lib/ingestion/traverse-diff-inputs";
import type { Camp } from "../lib/types";

type ComputeDiff = typeof currentComputeDiff;
type JsonObject = Record<string, unknown>;
type Classification = "below-confidence" | "missing-candidate" | "unchanged" | "suppressed-30d" | "populate" | "update" | "add_items" | "NOT_REPLAYABLE";
const FILES = ["manifest.json", "crawl-run.json", "proposals.json", "camps.json"] as const;
const FIELDS = ["name", "organizationName", "description", "registrationStatus", "registrationOpenDate", "registrationCloseDate", "lunchIncluded", "address", "neighborhood", "city", "websiteUrl", "applicationUrl", "contactEmail", "contactPhone", "socialLinks", "interestingDetails", "state", "zip", "campTypes", "categories", "ageGroups", "schedules", "pricing"] as const;
const RELATIONS = new Set<string>(["ageGroups", "schedules", "pricing"]);

function object(value: unknown, label: string): JsonObject {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  return value as JsonObject;
}
function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label}: expected array`);
  return value;
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function sha(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function manifest(root: string): Record<string, string> {
  return Object.fromEntries(FILES.map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]));
}
function semanticEqual(left: unknown, right: unknown): boolean {
  try { assert.deepStrictEqual(left, right); return true; } catch { return false; }
}
function gitShow(ref: string, file: string): string {
  return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" });
}

const requested = path.resolve(process.argv[2] ?? ".d1-replay-sample");
const root = fs.realpathSync(requested);
const expectedDefault = fs.realpathSync(path.resolve(".d1-replay-sample"));
assert.equal(root, expectedDefault, "sample root must be the repository's .d1-replay-sample directory");
for (const name of FILES) {
  const candidate = fs.realpathSync(path.join(root, name));
  assert(within(root, candidate), `${name}: path escaped sample root`);
  assert.equal(path.dirname(candidate), root, `${name}: nested/aliased input rejected`);
}
const beforeHashes = manifest(root);
const parsed = Object.fromEntries(FILES.map((name) => [name, JSON.parse(fs.readFileSync(path.join(root, name), "utf8"))]));
const manifestJson = object(parsed["manifest.json"], "manifest");
const run = object(parsed["crawl-run.json"], "crawl-run");
const proposals = array(parsed["proposals.json"], "proposals").map((value, index) => object(value, `proposal[${index}]`));
const camps = array(parsed["camps.json"], "camps").map((value, index) => object(value, `camp[${index}]`));
assert.equal(proposals.length, 30, "proposal count mismatch");
assert.equal(camps.length, 29, "camp count mismatch");
assert.equal(run.id, manifestJson.crawlRunId, "crawl-run/manifest join mismatch");
assert.equal((object(manifestJson.counts, "manifest.counts").proposals), proposals.length, "manifest proposal count mismatch");
assert.equal((object(manifestJson.counts, "manifest.counts").camps), camps.length, "manifest camp count mismatch");
const campsById = new Map(camps.map((camp) => [camp.id, camp]));
assert.equal(new Set(camps.map((camp) => camp.id)).size, camps.length, "duplicate camp key");
for (const proposal of proposals) {
  assert.equal(proposal.crawlRunId, run.id, "proposal/crawl-run join mismatch");
  assert(campsById.has(proposal.campId), "proposal/camp join mismatch");
  const raw = object(proposal.rawExtraction, "proposal.rawExtraction");
  assert(Array.isArray(raw.proposals), "raw extraction proposal array missing");
}

const legacyRefInput = process.env.D1_LEGACY_REF;
assert(legacyRefInput, "D1_LEGACY_REF is required");
const legacySha = execFileSync("git", ["rev-parse", `${legacyRefInput}^{commit}`], { encoding: "utf8" }).trim();
assert.equal(legacySha, legacyRefInput, "D1_LEGACY_REF must be a full immutable commit SHA");
const currentSha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "campfit-d1-legacy-"));
const ingestionRoot = path.join(tempRoot, "lib", "ingestion");
fs.mkdirSync(ingestionRoot, { recursive: true });
fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ type: "module" }));
for (const name of ["diff-engine.ts", "diff-kernel.ts"]) fs.writeFileSync(path.join(ingestionRoot, name), gitShow(legacySha, `lib/ingestion/${name}`));
// The D1 baseline already contains D0's persistence-field correction. A separate,
// immutable pre-D0 materialization makes the anti-laundering probe meaningful
// without changing which classifier is used for the production replay itself.
const sentinelSha = execFileSync("git", ["rev-parse", "7cfddde^{}^"], { encoding: "utf8" }).trim();
const sentinelRoot = path.join(tempRoot, "persistence-inclusive-sentinel");
const sentinelIngestionRoot = path.join(sentinelRoot, "lib", "ingestion");
fs.mkdirSync(sentinelIngestionRoot, { recursive: true });
fs.writeFileSync(path.join(sentinelRoot, "package.json"), JSON.stringify({ type: "module" }));
for (const name of ["diff-engine.ts", "diff-kernel.ts"]) fs.writeFileSync(path.join(sentinelIngestionRoot, name), gitShow(sentinelSha, `lib/ingestion/${name}`));

let writesAttempted = 0;
const blocked = () => { writesAttempted += 1; throw new Error("WRITE_ISOLATION: replay write rejected"); };
const guardedMethods = ["appendFile", "appendFileSync", "copyFile", "copyFileSync", "createWriteStream", "rename", "renameSync", "truncate", "truncateSync", "unlink", "unlinkSync", "write", "writeFile", "writeFileSync"] as const;
const originals = new Map<string, unknown>();
for (const method of guardedMethods) { originals.set(method, (fs as unknown as JsonObject)[method]); (fs as unknown as JsonObject)[method] = blocked; }

let legacyPathGuard = false;
let currentPathGuard = false;
let rows: Array<{ sampleOrdinal: number; field: string; oldClassification: Classification; newClassification: Classification; suppressionBucket: string; explanation: string }> = [];
const coverage = { old: {} as Record<string, number>, current: {} as Record<string, number>, suppression: {} as Record<string, number> };
let notReplayable = 0;
let newlySurfaced = 0;
let proposalSetMismatches = 0;
let sentinel: { legacy: string; current: string } | undefined;

function classify(compute: ComputeDiff, camp: Camp, extracted: Record<string, unknown>, confidence: Record<string, number>, excerpts: Record<string, string>, fieldSources: Record<string, { approvedAt?: string }>, sourceUrl: string, field: string): Classification {
  const candidate = extracted[field];
  if (candidate === undefined || candidate === null || (Array.isArray(candidate) && candidate.length === 0)) return "missing-candidate";
  if ((confidence[field] ?? 0) < 0.3) return "below-confidence";
  if (RELATIONS.has(field) && !Array.isArray((camp as unknown as JsonObject)[field])) return "NOT_REPLAYABLE";
  const emitted = compute(camp, extracted, confidence, excerpts, fieldSources, sourceUrl)[field];
  if (emitted) return emitted.mode as Classification;
  if (fieldSources[field]?.approvedAt) {
    const withoutApproval = { ...fieldSources, [field]: {} };
    if (compute(camp, extracted, confidence, excerpts, withoutApproval, sourceUrl)[field]) return "suppressed-30d";
  }
  return "unchanged";
}
function bucket(fieldSources: Record<string, { approvedAt?: string }>, confidence: number, now: number, field: string): string {
  const approvedAt = fieldSources[field]?.approvedAt;
  if (!approvedAt) return "no-approval";
  const inside = (now - new Date(approvedAt).getTime()) / 86_400_000 < 30;
  return `${inside ? "<30d" : ">=30d"},${confidence < 0.8 ? "<0.8" : ">=0.8"}`;
}

try {
  const legacyUrl = pathToFileURL(path.join(ingestionRoot, "diff-engine.ts"));
  const legacyModule = await import(`${legacyUrl.href}?sha=${legacySha}`) as { computeDiff: ComputeDiff };
  const sentinelUrl = pathToFileURL(path.join(sentinelIngestionRoot, "diff-engine.ts"));
  const sentinelModule = await import(`${sentinelUrl.href}?sha=${sentinelSha}`) as { computeDiff: ComputeDiff };
  const resolvedLegacy = fs.realpathSync(fileURLToPath(legacyUrl));
  legacyPathGuard = within(fs.realpathSync(tempRoot), resolvedLegacy) && !within(fs.realpathSync(process.cwd()), resolvedLegacy);
  const currentUrl = new URL("../lib/ingestion/diff-engine.ts", import.meta.url);
  currentPathGuard = within(fs.realpathSync(process.cwd()), fs.realpathSync(fileURLToPath(currentUrl)));
  assert(legacyPathGuard && currentPathGuard, "classifier module path guard failed");
  assert.notEqual(legacyModule.computeDiff, currentComputeDiff, "classifier imports resolve to same implementation");

  const sentinelCamp = { ageGroups: [{ id: "legacy-only", campId: "legacy-owner", label: "sentinel", minAge: 1, maxAge: 2, minGrade: null, maxGrade: null }], fieldSources: {} } as unknown as Camp;
  const sentinelExtracted = { ageGroups: [{ label: "sentinel", minAge: 1, maxAge: 2, minGrade: null, maxGrade: null }] };
  const sentinelLegacy = sentinelModule.computeDiff(sentinelCamp, sentinelExtracted, { ageGroups: 0.9 }).ageGroups?.mode ?? "unchanged";
  const sentinelCurrent = currentComputeDiff(sentinelCamp, sentinelExtracted, { ageGroups: 0.9 }).ageGroups?.mode ?? "unchanged";
  assert.notEqual(sentinelLegacy, sentinelCurrent, "anti-laundering sentinel did not diverge");
  sentinel = { legacy: sentinelLegacy, current: sentinelCurrent };

  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index];
    const raw = object(proposal.rawExtraction, "proposal.rawExtraction");
    const items = assembleItems(raw.proposals as ExtractionProposal[]);
    const itemIndex = raw.itemIndex;
    assert(Number.isInteger(itemIndex), "captured item index missing");
    const item = items.find((candidate) => candidate.itemIndex === itemIndex) ?? (items.length === 1 ? items[0] : undefined);
    assert(item, "captured item index not found in assembled extraction");
    const inputs = assembledItemToDiffInputs(item);
    const campRecord = { ...campsById.get(proposal.campId) } as JsonObject;
    const capturedChanges = object(proposal.proposedChanges, "proposal.proposedChanges");
    for (const field of RELATIONS) {
      if (!Array.isArray((inputs.extracted as JsonObject)[field])) continue;
      if (Array.isArray(campRecord[field])) continue;
      const captured = capturedChanges[field];
      if (captured && typeof captured === "object" && Array.isArray((captured as JsonObject).old)) campRecord[field] = (captured as JsonObject).old;
    }
    const fieldSources = (campRecord.fieldSources && typeof campRecord.fieldSources === "object" ? campRecord.fieldSources : {}) as Record<string, { approvedAt?: string }>;
    const now = new Date(proposal.createdAt as string).getTime();
    assert(Number.isFinite(now), "proposal creation instant invalid");
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const oldOutput = legacyModule.computeDiff(campRecord as unknown as Camp, inputs.extracted, inputs.confidence, inputs.excerpts, fieldSources, proposal.sourceUrl as string);
      const newOutput = currentComputeDiff(campRecord as unknown as Camp, inputs.extracted, inputs.confidence, inputs.excerpts, fieldSources, proposal.sourceUrl as string);
      const oldSet = Object.keys(oldOutput).sort();
      const newSet = Object.keys(newOutput).sort();
      if (!semanticEqual(oldSet, newSet)) proposalSetMismatches += 1;
      for (const field of FIELDS) {
        const oldClassification = classify(legacyModule.computeDiff, campRecord as unknown as Camp, inputs.extracted as JsonObject, inputs.confidence, inputs.excerpts, fieldSources, proposal.sourceUrl as string, field);
        const newClassification = classify(currentComputeDiff, campRecord as unknown as Camp, inputs.extracted as JsonObject, inputs.confidence, inputs.excerpts, fieldSources, proposal.sourceUrl as string, field);
        coverage.old[oldClassification] = (coverage.old[oldClassification] ?? 0) + 1;
        coverage.current[newClassification] = (coverage.current[newClassification] ?? 0) + 1;
        const suppressionBucket = bucket(fieldSources, inputs.confidence[field] ?? 0, now, field);
        coverage.suppression[suppressionBucket] = (coverage.suppression[suppressionBucket] ?? 0) + 1;
        if (oldClassification === "NOT_REPLAYABLE" || newClassification === "NOT_REPLAYABLE") notReplayable += 1;
        const oldEmitted = ["populate", "update", "add_items"].includes(oldClassification);
        const newEmitted = ["populate", "update", "add_items"].includes(newClassification);
        if (!oldEmitted && newEmitted) newlySurfaced += 1;
        const oldField = oldOutput[field]; const newField = newOutput[field];
        const outputEqual = (!oldField && !newField) || (!!oldField && !!newField && semanticEqual({ mode: oldField.mode, old: oldField.old, new: oldField.new, confidence: oldField.confidence, excerpt: oldField.excerpt, sourceUrl: oldField.sourceUrl }, { mode: newField.mode, old: newField.old, new: newField.new, confidence: newField.confidence, excerpt: newField.excerpt, sourceUrl: newField.sourceUrl }));
        if (oldClassification !== newClassification || !outputEqual) rows.push({ sampleOrdinal: index + 1, field, oldClassification, newClassification, suppressionBucket, explanation: oldClassification === "suppressed-30d" || newClassification === "suppressed-30d" ? "suppression-policy-explained" : "unexplained" });
      }
    } finally { Date.now = originalNow; }
  }
} finally {
  for (const [method, original] of originals) (fs as unknown as JsonObject)[method] = original;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const afterHashes = manifest(root);
assert.deepStrictEqual(afterHashes, beforeHashes, "private sample hashes changed");
const unexplained = rows.filter((row) => row.explanation === "unexplained").length;
console.log(`D1 REPLAY legacySha=${legacySha} currentSha=${currentSha}`);
console.log(`GUARDS legacyTempOutsideWorktree=${legacyPathGuard} currentInWorktree=${currentPathGuard} sentinelLegacy=${sentinel?.legacy} sentinelCurrent=${sentinel?.current} writesAttempted=${writesAttempted} sampleHashesUnchanged=true`);
console.log(`COVERAGE ${JSON.stringify(coverage)}`);
console.log(`SUMMARY ${JSON.stringify({ proposals: proposals.length, camps: camps.length, divergences: rows.length, unexplained, newlySurfaced, notReplayable, proposalSetMismatches })}`);
for (const row of rows) console.log(`DIVERGENCE ${JSON.stringify(row)}`);
assert.equal(writesAttempted, 0, "write API was attempted during replay");
assert.equal(unexplained, 0, "unexplained semantic divergence");
assert.equal(newlySurfaced, 0, "newly surfaced proposal");
assert.equal(notReplayable, 0, "NOT_REPLAYABLE field");
assert.equal(proposalSetMismatches, 0, "proposal-set mismatch");
