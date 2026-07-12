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
const AUTHORITATIVE_LEGACY_SHA = "658946955f0f5017ed08d15c5df3a3ff624ba276";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, label: string): JsonObject {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label}: object shape invalid`);
  return value as JsonObject;
}
function array(value: unknown, label: string): unknown[] {
  invariant(Array.isArray(value), `${label}: array shape invalid`);
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const nested of Object.values(value as JsonObject)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

async function main(): Promise<void> {

const requested = path.resolve(process.argv[2] ?? ".d1-replay-sample");
const root = fs.realpathSync(requested);
const expectedDefault = fs.realpathSync(path.resolve(".d1-replay-sample"));
invariant(root === expectedDefault, "sample root rejected");
for (const name of FILES) {
  const candidate = fs.realpathSync(path.join(root, name));
  invariant(within(root, candidate), `${name}: path containment check failed`);
  invariant(path.dirname(candidate) === root, `${name}: direct-file shape check failed`);
}
const beforeHashes = manifest(root);
const parsed = Object.fromEntries(FILES.map((name) => [name, JSON.parse(fs.readFileSync(path.join(root, name), "utf8"))]));
const manifestJson = object(parsed["manifest.json"], "manifest");
const run = object(parsed["crawl-run.json"], "crawl-run");
const proposals = array(parsed["proposals.json"], "proposals").map((value, index) => object(value, `proposal[${index}]`));
const camps = array(parsed["camps.json"], "camps").map((value, index) => object(value, `camp[${index}]`));
invariant(proposals.length === 30, "proposal aggregate count mismatch");
invariant(camps.length === 29, "camp aggregate count mismatch");
invariant(run.id === manifestJson.crawlRunId, "crawl-run/manifest join failed");
invariant(object(manifestJson.counts, "manifest.counts").proposals === proposals.length, "manifest proposal aggregate mismatch");
invariant(object(manifestJson.counts, "manifest.counts").camps === camps.length, "manifest camp aggregate mismatch");
const campsById = new Map(camps.map((camp) => [camp.id, camp]));
invariant(new Set(camps.map((camp) => camp.id)).size === camps.length, "camp join keys are not unique");
for (const proposal of proposals) {
  invariant(proposal.crawlRunId === run.id, "proposal/crawl-run join failed");
  invariant(campsById.has(proposal.campId), "proposal/camp join failed");
  const raw = object(proposal.rawExtraction, "proposal.rawExtraction");
  invariant(Array.isArray(raw.proposals), "raw extraction proposal array shape invalid");
}

const legacyRefInput = process.env.D1_LEGACY_REF;
invariant(!legacyRefInput || legacyRefInput === AUTHORITATIVE_LEGACY_SHA, "D1_LEGACY_REF does not match the authoritative baseline");
const legacySha = execFileSync("git", ["rev-parse", `${AUTHORITATIVE_LEGACY_SHA}^{commit}`], { encoding: "utf8" }).trim();
invariant(legacySha === AUTHORITATIVE_LEGACY_SHA, "authoritative legacy baseline is unavailable");
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
// open/openSync are dual-use: Node's own fs.readFileSync (and therefore the ESM
// loader importing the materialized legacy module) routes through fs.openSync
// with read-only flags. Block only write-capable opens; pure reads pass through.
const WRITE_OPEN_BITS =
  fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND |
  fs.constants.O_CREAT | fs.constants.O_TRUNC;
const isReadOnlyOpenFlags = (flags: unknown): boolean => {
  if (flags === undefined || flags === null) return true;
  if (typeof flags === "string") return flags === "r" || flags === "rs" || flags === "sr";
  if (typeof flags === "number") return (flags & WRITE_OPEN_BITS) === 0;
  return false;
};
const guardOpen = (original: unknown) =>
  function guardedOpen(this: unknown, ...args: unknown[]) {
    if (!isReadOnlyOpenFlags(args[1])) return blocked();
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
const guardedMethods = [
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "fchmod",
  "fchmodSync", "fchown", "fchownSync", "fdatasync", "fdatasyncSync", "ftruncate",
  "ftruncateSync", "futimes", "futimesSync", "lchmod", "lchmodSync", "lchown",
  "lchownSync", "link", "linkSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync",
  "mkdtemp", "mkdtempSync", "rename", "renameSync", "rm",
  "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate",
  "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "write",
  "writeFile", "writeFileSync", "writeSync", "writev", "writevSync",
] as const;
const originals = new Map<string, unknown>();
for (const method of guardedMethods) {
  if (typeof (fs as unknown as JsonObject)[method] !== "function") continue;
  originals.set(method, (fs as unknown as JsonObject)[method]);
  (fs as unknown as JsonObject)[method] = blocked;
}
for (const method of ["open", "openSync"] as const) {
  originals.set(method, (fs as unknown as JsonObject)[method]);
  (fs as unknown as JsonObject)[method] = guardOpen((fs as unknown as JsonObject)[method]);
}
const promiseGuardedMethods = [
  "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link",
  "lutimes", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink",
  "truncate", "unlink", "utimes", "writeFile",
] as const;
const promiseOriginals = new Map<string, unknown>();
for (const method of promiseGuardedMethods) {
  if (typeof (fs.promises as unknown as JsonObject)[method] !== "function") continue;
  promiseOriginals.set(method, (fs.promises as unknown as JsonObject)[method]);
  (fs.promises as unknown as JsonObject)[method] = blocked;
}
promiseOriginals.set("open", (fs.promises as unknown as JsonObject).open);
(fs.promises as unknown as JsonObject).open = guardOpen((fs.promises as unknown as JsonObject).open);
// Blocking fs.promises.open prevents this runtime from creating a FileHandle and
// reaching write(), writeFile(), appendFile(), truncate(), or createWriteStream().
// JavaScript cannot enumerate handles opened by unrelated code before this guard;
// this script creates and retains no such handle.

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
    invariant(Number.isInteger(itemIndex), "captured item index shape invalid");
    const item = items.find((candidate) => candidate.itemIndex === itemIndex) ?? (items.length === 1 ? items[0] : undefined);
    invariant(item, "captured item index join failed");
    const inputs = deepFreeze(assembledItemToDiffInputs(item));
    const campRecord = { ...campsById.get(proposal.campId) } as JsonObject;
    const capturedChanges = object(proposal.proposedChanges, "proposal.proposedChanges");
    for (const field of RELATIONS) {
      if (!Array.isArray((inputs.extracted as JsonObject)[field])) continue;
      if (Array.isArray(campRecord[field])) continue;
      const captured = capturedChanges[field];
      if (captured && typeof captured === "object" && Array.isArray((captured as JsonObject).old)) campRecord[field] = (captured as JsonObject).old;
    }
    const fieldSources = deepFreeze((campRecord.fieldSources && typeof campRecord.fieldSources === "object" ? campRecord.fieldSources : {}) as Record<string, { approvedAt?: string }>);
    deepFreeze(campRecord);
    const now = new Date(proposal.createdAt as string).getTime();
    invariant(Number.isFinite(now), "proposal creation instant shape invalid");
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
  for (const [method, original] of promiseOriginals) (fs.promises as unknown as JsonObject)[method] = original;
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
}

main().catch(() => {
  // Never expose assertion actual/expected payloads or captured corpus strings.
  console.error("D1 REPLAY FAILED: sanitized invariant failure; inspect aggregate counters only");
  process.exitCode = 1;
});
