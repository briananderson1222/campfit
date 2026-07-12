import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ProposalDiffEvent } from "@kontourai/lookout";
import { createObservationStore } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import { eventsToProposedChanges } from "../lib/ingestion/lookout-event-mapper";
import { emitCampfitObservation, persistSurveyInput } from "../lib/ingestion/lookout-observation-store";

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
  const proposal = (value: string, excerpt: string): ExtractionProposal => ({
    fieldPath: "items[].name", candidateValue: value, confidence: 0.91,
    provenance: { excerpt, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0],
  });
  const baseline = await emitCampfitObservation({
    source, entityKey: "camp-1", checkedAt: "2026-07-11T00:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: "snapshot:one", observedAt: "2026-07-11T00:00:00.000Z", proposals: [proposal("Old", "Old")] },
    proposals: [proposal("Old", "Old")], store: observationStore, spoolRoot: path.join(runtimeRoot, "survey"),
  });
  assert.equal(baseline.ok, true);
  if (baseline.ok) {
    assert.equal(baseline.value.events.length, 0, "first enablement seeds baseline without mass emission");
    assert.equal(baseline.value.surveyInput, null);
  }
  const changed = await emitCampfitObservation({
    source, entityKey: "camp-1", checkedAt: "2026-07-12T00:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: "snapshot:two", observedAt: "2026-07-12T00:00:00.000Z", proposals: [proposal("New", "New")] },
    proposals: [proposal("New", "New")], store: observationStore, spoolRoot: path.join(runtimeRoot, "survey"),
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
  await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-11T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: "snapshot:baseline", observedAt: "2026-07-11T00:00:00.000Z", proposals: [proposal("Old")] }, proposals: [proposal("Old")], store: observationStore, spoolRoot });

  const commitFailed = await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-12T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: "snapshot:commit-fails", observedAt: "2026-07-12T00:00:00.000Z", proposals: [proposal("New")] }, proposals: [proposal("New")], store: observationStore, spoolRoot, faults: { beforeObservationCommit: () => { throw new Error("injected commit failure"); } } });
  assert.equal(commitFailed.ok, false, "a commit failure cannot claim emission success");
  assert.deepEqual((await readdir(spoolRoot)).filter((name) => name.endsWith(".json")), [], "pending Survey is not consumer-visible");
  const afterCommitFailure = await observationStore.loadLatest(source.id);
  assert.equal(afterCommitFailure.ok && afterCommitFailure.value?.snapshotRef, "snapshot:baseline", "failed commit does not advance pointer");

  const finalizeFailed = await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-13T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: "snapshot:finalize-fails", observedAt: "2026-07-13T00:00:00.000Z", proposals: [proposal("Newer")] }, proposals: [proposal("Newer")], store: observationStore, spoolRoot, faults: { beforeSurveyFinalize: () => { throw new Error("injected finalize failure"); } } });
  assert.equal(finalizeFailed.ok, false, "a finalize failure cannot claim emission success");
  assert.deepEqual((await readdir(spoolRoot)).filter((name) => name.endsWith(".json")), [], "unfinalized Survey remains invisible");
  const afterFinalizeFailure = await observationStore.loadLatest(source.id);
  assert.equal(afterFinalizeFailure.ok && afterFinalizeFailure.value?.snapshotRef, "snapshot:finalize-fails", "committed pointer is recoverable");
  const retried = await emitCampfitObservation({ source, entityKey: source.id, checkedAt: "2026-07-13T00:00:00.000Z", observation: { sourceId: source.id, snapshotRef: "snapshot:finalize-fails", observedAt: "2026-07-13T00:00:00.000Z", proposals: [proposal("Newer")] }, proposals: [proposal("Newer")], store: observationStore, spoolRoot });
  assert.equal(retried.ok, true, "retry recovers the committed pending delivery");
  assert.equal((await readdir(spoolRoot)).filter((name) => name.endsWith(".json")).length, 1, "recovery publishes exactly one Survey batch");
} finally { await rm(failureRoot, { recursive: true, force: true }); }

console.log("L4 Lookout event/removal/survey spool contracts passed");
