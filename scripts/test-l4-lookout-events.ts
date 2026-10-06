import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { ProposalDiffEvent } from "@kontourai/lookout";
import { createObservationStore } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import { buildSnapshotSourceRef, type Snapshot, type SnapshotStore } from "@kontourai/traverse/fetch";
import { buildSnapshotSourceRef as buildForageSnapshotRef } from "@kontourai/forage/fetch";
import { eventsToProposedChanges } from "../lib/ingestion/lookout-event-mapper";
import { emitCampfitObservation, persistSurveyInput } from "../lib/ingestion/lookout-observation-store";
import { runLookoutRecrawlForCamp } from "../lib/ingestion/lookout-check-adapter";
import { deliverRecrawlReview } from "../lib/ingestion/crawl-pipeline";
import type { TraverseRecrawlResult } from "../lib/ingestion/traverse-recrawl-adapter";
import type { Camp } from "../lib/types";
import { lookoutSourceId } from "../lib/ingestion/lookout-sources";

// A fetch returns a Forage capture: response headers, no contentType. Lookout's
// fromTraverseSnapshotStore adds the contentType when it stores one.
const forage = (record: Snapshot) => {
  const { contentType: _contentType, ...capture } = record;
  void _contentType;
  return { ...capture, headers: { "content-type": "text/html" } };
};

const evidence = { sourceId: "camp-1", snapshotRef: "traverse-snapshot:camp-1?url=https://camp.test&sha256=abc&fetchedAt=x", observedAt: "2026-07-11T00:00:00.000Z", entityKey: "camp-1", fieldKey: "name", value: "New", confidence: 0.91, provenance: { excerpt: "New", locator: "chars:0-3" }, extractor: "fixture", fieldPath: "name" };
const events: ProposalDiffEvent[] = [
  { kind: "field-changed", entityKey: "camp-1", fieldKey: "name", changeKind: "value-updated", prior: { ...evidence, value: "Old" }, current: evidence },
  { kind: "field-changed", entityKey: "camp-1", fieldKey: "removed", changeKind: "items-removed", prior: { ...evidence, fieldKey: "removed" } },
];
const mapped = eventsToProposedChanges(events, "https://camp.test", new Set(["name", "removed"]));
assert.equal(mapped.changes.name?.new, "New");
assert.equal(mapped.changes.name?.mode, "update");
assert.equal(mapped.changes.name?.sourceUrl, "https://camp.test");
assert.equal(mapped.changes.removed, undefined);
assert.deepEqual(mapped.warnings, ["removal-not-proposed:camp-1:removed"]);
const invalid = eventsToProposedChanges(events, "https://camp.test", new Set(["city"]));
assert.equal(invalid.changes.name, undefined);
assert.ok(invalid.warnings.includes("unsupported-field-not-proposed:camp-1:name"));

// Lookout 0.7+ resolves every observation's snapshot reference through the
// snapshot store before diffing, so direct emissions need real captures.
function captureStore() {
  const history: Snapshot[] = [];
  const store: SnapshotStore = {
    latest: async (sourceId) => history.filter((item) => item.sourceId === sourceId).at(-1),
    get: async (sourceId, bodyHash) => history.find((item) => item.sourceId === sourceId && item.bodyHash === bodyHash),
    list: async (sourceId) => history.filter((item) => item.sourceId === sourceId).reverse(),
    put: async (next) => { history.push(next); },
  };
  const capture = (sourceId: string, url: string, body: string, fetchedAt: string): string => {
    const snapshot: Snapshot = { sourceId, url, fetchedAt, status: 200, contentType: "html", body, bodyHash: createHash("sha256").update(body).digest("hex") };
    history.push(snapshot);
    // Lookout's CHECK hands the emitter Forage references, so that is the
    // reference shape observations carry in production.
    return buildForageSnapshotRef(snapshot);
  };
  return { store, capture };
}

const root = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-survey-"));
try {
  const input = { source: "fixture", generatedAt: "2026-07-11T00:00:00.000Z", rawSources: [], extractions: [], candidateSets: [], claims: [], reviewOutcomes: [] } as never;
  const first = await persistSurveyInput(input, root);
  const second = await persistSurveyInput(input, root);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.path, second.path);
  assert.equal((await readdir(root)).length, 1);
  const body = await readFile(first.path, "utf8");
  assert.doesNotThrow(() => JSON.parse(body));
} finally { await rm(root, { recursive: true, force: true }); }

const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-emission-"));
try {
  const observationStore = createObservationStore({ root: path.join(runtimeRoot, "observations") });
  const source = { id: "camp-1", url: "https://camp.test", kind: "web-page" as const, targetSchema: [], cadenceHint: "test", renderPolicy: "never" as const };
  const { store: snapshotStore, capture } = captureStore();
  const refOne = capture(source.id, source.url, "one", "2026-07-11T00:00:00.000Z");
  const refTwo = capture(source.id, source.url, "two", "2026-07-12T00:00:00.000Z");
  const proposal = (value: string, excerpt: string): ExtractionProposal => ({
    fieldPath: "items[].name", candidateValue: value, confidence: 0.91,
    provenance: { excerpt, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0],
  });
  const baseline = await emitCampfitObservation({
    source, entityKey: "camp-1", checkedAt: "2026-07-11T00:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: refOne, observedAt: "2026-07-11T00:00:00.000Z", proposals: [proposal("Old", "Old")] },
    proposals: [proposal("Old", "Old")], store: observationStore, snapshotStore, spoolRoot: path.join(runtimeRoot, "survey"),
  });
  assert.equal(baseline.ok, true, baseline.ok ? "" : `${baseline.error.kind}: ${baseline.error.message}`);
  if (baseline.ok) {
    assert.equal(baseline.value.events.length, 0, "first enablement seeds baseline without mass emission");
    assert.equal(baseline.value.surveyInput, null);
  }
  const changed = await emitCampfitObservation({
    source, entityKey: "camp-1", checkedAt: "2026-07-12T00:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: refTwo, observedAt: "2026-07-12T00:00:00.000Z", proposals: [proposal("New", "New")] },
    proposals: [proposal("New", "New")], store: observationStore, snapshotStore, spoolRoot: path.join(runtimeRoot, "survey"),
  });
  assert.equal(changed.ok, true);
  if (changed.ok) assert.equal(changed.value.events.length, 1);
  const surveyFiles = (await readdir(path.join(runtimeRoot, "survey"))).filter((name) => name.endsWith(".json"));
  assert.equal(surveyFiles.length, 1, "event survey is durably spooled before observation commit");
  const [surveyFile] = surveyFiles;
  const spooled = JSON.parse(await readFile(path.join(runtimeRoot, "survey", surveyFile), "utf8")) as { claims: Array<{ subjectType: string; subjectId: string }> };
  assert.equal(spooled.claims[0]?.subjectType, "campfit.camp");
  assert.equal(spooled.claims[0]?.subjectId, "camp-1");
} finally { await rm(runtimeRoot, { recursive: true, force: true }); }

const failureRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-emission-failure-"));
try {
  const observationStore = createObservationStore({ root: path.join(failureRoot, "observations") });
  const spoolRoot = path.join(failureRoot, "survey");
  const source = { id: "camp-failure", url: "https://camp.test", kind: "web-page" as const, targetSchema: [], cadenceHint: "test", renderPolicy: "never" as const };
  const proposal = (value: string): ExtractionProposal => ({ fieldPath: "items[].name", candidateValue: value, confidence: 0.9, provenance: { excerpt: value, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] });
  const { store: snapshotStore, capture } = captureStore();
  const refs = {
    baseline: capture(source.id, source.url, "baseline", "2026-07-11T00:00:00.000Z"),
    commitFails: capture(source.id, source.url, "commit-fails", "2026-07-12T00:00:00.000Z"),
    finalizeFails: capture(source.id, source.url, "finalize-fails", "2026-07-13T00:00:00.000Z"),
  };
  await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-11T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: refs.baseline, observedAt: "2026-07-11T00:00:00.000Z", proposals: [proposal("Old")] }, proposals: [proposal("Old")], store: observationStore, snapshotStore, spoolRoot });

  const commitFailed = await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-12T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: refs.commitFails, observedAt: "2026-07-12T00:00:00.000Z", proposals: [proposal("New")] }, proposals: [proposal("New")], store: observationStore, snapshotStore, spoolRoot, faults: { beforeObservationCommit: () => { throw new Error("injected commit failure"); } } });
  assert.equal(commitFailed.ok, false, "a commit failure cannot claim emission success");
  assert.deepEqual((await readdir(spoolRoot)).filter((name) => name.endsWith(".json")), [], "pending Survey is not consumer-visible");
  const afterCommitFailure = await observationStore.loadLatest(source.id);
  assert.equal(afterCommitFailure.ok && afterCommitFailure.value?.snapshotRef, refs.baseline, "failed commit does not advance pointer");

  const finalizeFailed = await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-13T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: refs.finalizeFails, observedAt: "2026-07-13T00:00:00.000Z", proposals: [proposal("Newer")] }, proposals: [proposal("Newer")], store: observationStore, snapshotStore, spoolRoot, faults: { beforeSurveyFinalize: () => { throw new Error("injected finalize failure"); } } });
  assert.equal(finalizeFailed.ok, false, "a finalize failure cannot claim emission success");
  assert.deepEqual((await readdir(spoolRoot)).filter((name) => name.endsWith(".json")), [], "unfinalized Survey remains invisible");
  const afterFinalizeFailure = await observationStore.loadLatest(source.id);
  assert.equal(afterFinalizeFailure.ok && afterFinalizeFailure.value?.snapshotRef, refs.finalizeFails, "committed pointer is recoverable");
  const retried = await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-13T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: refs.finalizeFails, observedAt: "2026-07-13T00:00:00.000Z", proposals: [proposal("Newer")] }, proposals: [proposal("Newer")], store: observationStore, snapshotStore, spoolRoot });
  assert.equal(retried.ok, true, "retry recovers the committed pending delivery");
  assert.equal((await readdir(spoolRoot)).filter((name) => name.endsWith(".json")).length, 1, "recovery publishes exactly one Survey batch");
} finally { await rm(failureRoot, { recursive: true, force: true }); }

// Production-shaped crash-window proof for the named EVENTS gate. A changed
// coordinator run stages a batch and advances the observation before failing
// finalization. The next byte-identical (unchanged-hash) coordinator call must
// publish that batch at entry, before its unchanged early return.
const coordinatorRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-coordinator-recovery-"));
try {
  const campId = "camp-coordinator-recovery";
  const sourceId = lookoutSourceId(campId);
  const base: Snapshot = { sourceId, url: "https://recovery.test", fetchedAt: "2026-07-11T00:00:00.000Z", status: 200, contentType: "html", body: "Old", bodyHash: "bca97160f4e1211fe659338d0a9705a7dff8aa3ea2e1be1cc1958100a33962c2" };
  let latest: Snapshot = base;
  const history: Snapshot[] = [base];
  const snapshotStore: SnapshotStore = { latest: async () => latest, get: async (_sourceId, bodyHash) => history.find((item) => item.bodyHash === bodyHash), list: async () => [...new Set([latest, ...history])], put: async (next) => { history.push(next); latest = next; } };
  const observationStore = createObservationStore({ root: path.join(coordinatorRoot, "observations") });
  const surveySpoolRoot = path.join(coordinatorRoot, "survey");
  const proposal = (value: string): ExtractionProposal => ({ fieldPath: "items[].name", candidateValue: value, confidence: 0.9, provenance: { excerpt: value, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] });
  const replayCamp = async (): Promise<TraverseRecrawlResult> => ({ ok: true, error: null, proposedChanges: {}, overallConfidence: 0, model: "fixture", rawExtraction: { itemIndex: 0, itemName: "Recovery Camp", proposals: [proposal(latest.body)] }, matchedItemName: "Recovery Camp", itemCount: 1, snapshot: { ref: buildSnapshotSourceRef(latest), bodyHash: latest.bodyHash }, tokensUsed: 1, providerCalls: 1, latencyMs: 1, warnings: [] });
  const options = { campId, websiteUrl: base.url, campName: "Recovery Camp", current: { id: campId, websiteUrl: base.url, name: "Recovery Camp" } as unknown as Camp, provider: { name: "fixture", extract: async () => ({ proposals: [], raw: { response: "{}", model: "fixture" } }) }, store: snapshotStore };

  // Establish the native zero-event observation baseline.
  await runLookoutRecrawlForCamp(options, { observationStore, surveySpoolRoot, replayCamp, fetchSource: async () => ({ snapshot: forage(base) }) });
  const changed: Snapshot = { ...base, body: "New", bodyHash: "18fdd549b2ed367ac0c74cbec1214644728515b30edbcb78e7d322757a7c8359", fetchedAt: "2026-07-12T00:00:00.000Z" };
  const staged = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot, replayCamp,
    fetchSource: async () => ({ snapshot: forage(changed) }),
    emissionFaults: { beforeSurveyFinalize: () => { throw new Error("injected production finalize failure"); } },
  });
  assert.equal(staged.ok, false, "production coordinator exposes the staged finalize failure");
  latest = changed;
  assert.equal((await readdir(surveySpoolRoot)).filter((name) => name.endsWith(".json")).length, 0, "staged batch is not yet consumer-visible");
  const unchanged = await runLookoutRecrawlForCamp(options, { observationStore, surveySpoolRoot, replayCamp, fetchSource: async () => ({ snapshot: forage(changed) }) });
  assert.equal(unchanged.ok, true, unchanged.error ?? "unchanged production recovery failed");
  assert.equal(unchanged.notModified, true, "recovery invocation follows the production unchanged path");
  assert.equal((await readdir(surveySpoolRoot)).filter((name) => name.endsWith(".json")).length, 1, "coordinator-entry recovery publishes the staged batch before unchanged return");
} finally { await rm(coordinatorRoot, { recursive: true, force: true }); }

// A version-1 observation written by Lookout 0.3.4 (tests/fixtures/
// lookout-0.3.4-observations, verbatim store layout) still loads under 0.8,
// is diffed against, and is replaced by a version-2 record on the next commit.
const storedRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-stored-v1-"));
try {
  await cp(path.join(process.cwd(), "tests/fixtures/lookout-0.3.4-observations"), path.join(storedRoot, "observations"), { recursive: true });
  const observationStore = createObservationStore({ root: path.join(storedRoot, "observations") });
  const loaded = await observationStore.loadLatest("stored-camp");
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error.message);
  assert.equal(loaded.ok && loaded.value?.version, 1, "the 0.3.4 record loads as version 1");
  const priorId = loaded.ok ? loaded.value!.observationId : "";

  const { store: snapshotStore, capture } = captureStore();
  // The stored record cites a legacy Forage reference (no envelope digest);
  // its capture must still be resolvable for the diff to be admitted.
  const legacy: Snapshot = { sourceId: "stored-camp", url: "https://stored.example.test/", fetchedAt: "2026-08-01T00:00:00.000Z", status: 200, contentType: "html", body: "same", bodyHash: "0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5" };
  await snapshotStore.put(legacy);
  const currentRef = capture("stored-camp", "https://stored.example.test/", "renamed", "2026-09-29T00:00:00.000Z");
  const source = { id: "stored-camp", url: "https://stored.example.test/", kind: "web-page" as const, targetSchema: [], cadenceHint: "test", renderPolicy: "never" as const };
  const renamed: ExtractionProposal = { fieldPath: "items[].name", candidateValue: "Renamed Camp", confidence: 0.9, provenance: { excerpt: "Renamed Camp", locator: "chars:0-12" }, extractor: "fixture", pathIndices: [0] };
  const emitted = await emitCampfitObservation({
    source, entityKey: source.id, checkedAt: "2026-09-29T00:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: currentRef, observedAt: "2026-09-29T00:00:00.000Z", proposals: [renamed] },
    proposals: [renamed], store: observationStore, snapshotStore, spoolRoot: path.join(storedRoot, "survey"),
  });
  assert.equal(emitted.ok, true, emitted.ok ? "" : `${emitted.error.kind}: ${emitted.error.message}`);
  if (emitted.ok) {
    assert.equal(emitted.value.priorObservationId, priorId, "diffed against the stored version-1 record");
    assert.equal(emitted.value.events.length, 1, "the rename is one event");
    assert.equal(emitted.value.committedObservation?.version, 2, "the next commit writes a version-2 record");
  }
} finally { await rm(storedRoot, { recursive: true, force: true }); }

// An incomplete replay reaches Lookout as an incomplete observation, so a
// proposal missing only because its text went unread is never reported as
// removed. The control run without the marker proves the removal would be
// reported otherwise.
for (const markIncomplete of [false, true]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-incomplete-"));
  try {
    const campId = `camp-incomplete-${markIncomplete}`;
    const sourceId = lookoutSourceId(campId);
    const base: Snapshot = { sourceId, url: "https://incomplete.test", fetchedAt: "2026-07-11T00:00:00.000Z", status: 200, contentType: "html", body: "Full", bodyHash: createHash("sha256").update("Full").digest("hex") };
    const next: Snapshot = { ...base, body: "Partial", bodyHash: createHash("sha256").update("Partial").digest("hex"), fetchedAt: "2026-07-12T00:00:00.000Z" };
    let latest = base;
    const history: Snapshot[] = [base];
    const snapshotStore: SnapshotStore = { latest: async () => latest, get: async (_s, bodyHash) => history.find((item) => item.bodyHash === bodyHash), list: async () => [...new Set([latest, ...history])], put: async (item) => { history.push(item); latest = item; } };
    const observationStore = createObservationStore({ root: path.join(root, "observations") });
    const proposal = (fieldPath: string, value: string): ExtractionProposal => ({ fieldPath, candidateValue: value, confidence: 0.9, provenance: { excerpt: value, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] });
    let phase: "baseline" | "partial" = "baseline";
    const replayCamp = async (): Promise<TraverseRecrawlResult> => ({
      ok: true, error: null, proposedChanges: {}, overallConfidence: 0, model: "fixture",
      rawExtraction: { itemIndex: 0, itemName: "Incomplete Camp", proposals: phase === "baseline"
        ? [proposal("items[].name", "Incomplete Camp"), proposal("items[].city", "Boulder")]
        : [proposal("items[].name", "Incomplete Camp")] },
      ...(phase === "partial" && markIncomplete ? { incomplete: { reason: "content-truncated" as const } } : {}),
      matchedItemName: "Incomplete Camp", itemCount: 1, snapshot: { ref: buildSnapshotSourceRef(latest), bodyHash: latest.bodyHash },
      tokensUsed: 1, providerCalls: 1, latencyMs: 1, warnings: [],
    });
    const options = { campId, websiteUrl: base.url, campName: "Incomplete Camp", current: { id: campId, websiteUrl: base.url, name: "Incomplete Camp" } as unknown as Camp, provider: { name: "fixture", extract: async () => ({ proposals: [], raw: { response: "{}", model: "fixture" } }) }, store: snapshotStore };
    const surveySpoolRoot = path.join(root, "survey");
    const first = await runLookoutRecrawlForCamp(options, { observationStore, surveySpoolRoot, replayCamp, fetchSource: async () => ({ snapshot: forage(base) }) });
    assert.equal(first.ok, true, first.error ?? "baseline failed");
    phase = "partial";
    const second = await runLookoutRecrawlForCamp(options, { observationStore, surveySpoolRoot, replayCamp, fetchSource: async () => ({ snapshot: forage(next) }) });
    assert.equal(second.ok, true, second.error ?? "partial run failed");
    const spooled = (await readdir(surveySpoolRoot).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
    const bodies = await Promise.all(spooled.map((name) => readFile(path.join(surveySpoolRoot, name), "utf8")));
    // Lookout reports the lost city as a change of the city field with only a
    // prior value; any spooled record about the city is that report.
    const reportsRemoval = bodies.some((body) => body.includes('"fieldKey":"city"'));
    assert.equal(reportsRemoval, !markIncomplete, markIncomplete
      ? "a city missing from an incomplete run must not be reported as removed"
      : "control: the same run without the marker reports the city removal");
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Forage 1.0 hashes a text page by its received bytes, so a page that is not
// plain UTF-8 reads as "changed" once after the upgrade although its text is
// the same. That one CHECK must cost one re-extraction and nothing else: no
// Survey batch, and no review proposal when the values equal the database.
{
  const root = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-rehash-"));
  try {
    const campId = "camp-rehash";
    const sourceId = lookoutSourceId(campId);
    const oldHash: Snapshot = { sourceId, url: "https://rehash.test", fetchedAt: "2026-09-28T00:00:00.000Z", status: 200, contentType: "html", body: "Café Camp", bodyHash: createHash("sha256").update("Café Camp").digest("hex") };
    const bytes = Uint8Array.from([...Buffer.from("Caf", "latin1"), 0xe9, ...Buffer.from(" Camp", "latin1")]);
    const rehashed = { ...oldHash, fetchedAt: "2026-09-29T09:00:00.000Z", bytes, declaredCharset: "windows-1252", bodyHash: createHash("sha256").update(bytes).digest("hex") } as unknown as Snapshot;
    let latest = oldHash;
    const history: Snapshot[] = [oldHash];
    const snapshotStore: SnapshotStore = { latest: async () => latest, get: async (_s, bodyHash) => history.find((item) => item.bodyHash === bodyHash), list: async () => [...new Set([latest, ...history])], put: async (item) => { history.push(item); latest = item; } };
    const observationStore = createObservationStore({ root: path.join(root, "observations") });
    const name: ExtractionProposal = { fieldPath: "items[].name", candidateValue: "Café Camp", confidence: 0.9, provenance: { excerpt: "Café Camp", locator: "chars:0-9" }, extractor: "fixture", pathIndices: [0] };
    let replays = 0;
    const replayCamp = async (): Promise<TraverseRecrawlResult> => ({
      ...(replays++, {}),
      ok: true, error: null, proposedChanges: {}, overallConfidence: 0, model: "fixture",
      rawExtraction: { itemIndex: 0, itemName: "Café Camp", proposals: [name] }, matchedItemName: "Café Camp", itemCount: 1,
      snapshot: { ref: buildSnapshotSourceRef(latest), bodyHash: latest.bodyHash }, tokensUsed: 1, providerCalls: 1, latencyMs: 1, warnings: [],
    });
    const options = { campId, websiteUrl: oldHash.url, campName: "Café Camp", current: { id: campId, websiteUrl: oldHash.url, name: "Café Camp" } as unknown as Camp, provider: { name: "fixture", extract: async () => ({ proposals: [], raw: { response: "{}", model: "fixture" } }) }, store: snapshotStore };
    const surveySpoolRoot = path.join(root, "survey");
    await runLookoutRecrawlForCamp(options, { observationStore, surveySpoolRoot, replayCamp, fetchSource: async () => ({ snapshot: forage(oldHash) }) });
    const before = replays;
    const result = await runLookoutRecrawlForCamp(options, { observationStore, surveySpoolRoot, replayCamp, fetchSource: async () => ({ snapshot: forage(rehashed) }) });
    assert.equal(result.ok, true, result.error ?? "rehash run failed");
    assert.equal(replays - before, 1, "the rehashed page is re-extracted once");
    assert.deepEqual((await readdir(surveySpoolRoot).catch(() => [] as string[])).filter((file) => file.endsWith(".json")), [], "no Survey batch for identical values");
    let sinkCalls = 0;
    assert.equal(await deliverRecrawlReview(result, async () => { sinkCalls++; return "proposal"; }), null);
    assert.equal(sinkCalls, 0, "no review proposal when the values equal the database");
  } finally { await rm(root, { recursive: true, force: true }); }
}

console.log("L4 Lookout event/removal/survey spool contracts passed");
