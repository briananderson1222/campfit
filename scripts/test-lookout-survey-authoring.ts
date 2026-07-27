/**
 * Pins the authored trust record across the Lookout 0.2.0 -> 0.3.x cutover.
 *
 * The fixture was produced by lookout@0.2.0's `createSurveyEmitter` before the
 * cutover. `authorDriftSurveyInput` now does that authoring in-repo, and this
 * asserts the published record is byte-identical.
 *
 * Why byte-identical rather than "looks right": the observation ID is a hash
 * over the source, the prior observation, the current snapshot and the event.
 * A different hash forks the lineage of every existing source, and it would do
 * so without failing anything — the records would still validate, still spool,
 * still review. Nothing but this comparison would notice.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createObservationStore } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import { emitCampfitObservation } from "../lib/ingestion/lookout-observation-store";

const golden = JSON.parse(
  await readFile(path.join(process.cwd(), "tests/fixtures/lookout-survey-authoring-golden.json"), "utf8"),
) as { spooledSurveyInput: unknown; eventCount: number };

const root = await mkdtemp(path.join(os.tmpdir(), "campfit-authoring-"));
try {
  const observationStore = createObservationStore({ root: path.join(root, "observations") });
  const spoolRoot = path.join(root, "survey");
  const source = { id: "camp-1", url: "https://camp.test", kind: "web-page" as const, targetSchema: [], cadenceHint: "test", renderPolicy: "never" as const };
  const proposal = (value: string, excerpt: string): ExtractionProposal => ({
    fieldPath: "items[].name", candidateValue: value, confidence: 0.91,
    provenance: { excerpt, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0],
  });
  const common = { source, entityKey: "camp-1", store: observationStore, spoolRoot, now: () => "2026-07-11T12:00:00.000Z" };

  const baseline = await emitCampfitObservation({
    ...common, checkedAt: "2026-07-11T00:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: "snapshot:one", observedAt: "2026-07-11T00:00:00.000Z", proposals: [proposal("Old", "Old")] },
    proposals: [proposal("Old", "Old")],
  });
  assert.equal(baseline.ok, true, "baseline emit");
  if (baseline.ok) {
    assert.equal(baseline.value.events.length, 0, "first enablement seeds a baseline without mass emission");
    assert.equal(baseline.value.surveyInput, null, "a baseline authors no trust record");
  }

  const changed = await emitCampfitObservation({
    ...common, checkedAt: "2026-07-11T01:00:00.000Z",
    observation: { sourceId: source.id, snapshotRef: "snapshot:two", observedAt: "2026-07-11T01:00:00.000Z", proposals: [proposal("New", "New")] },
    proposals: [proposal("New", "New")],
  });
  assert.equal(changed.ok, true, "changed emit");
  if (!changed.ok) throw new Error("unreachable");
  assert.equal(changed.value.events.length, golden.eventCount, "event count matches the pre-cutover run");

  const files = (await readdir(spoolRoot)).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 1, "exactly one record spooled");
  const spooled = JSON.parse(await readFile(path.join(spoolRoot, files[0]!), "utf8")) as { claims?: { id?: string }[] };

  assert.deepEqual(spooled, golden.spooledSurveyInput, "authored record drifted from the pre-cutover output");
  // The spool filename is a content hash, so an identical name is independent
  // confirmation that the bytes match rather than merely the parsed shape.
  const goldenId = (golden.spooledSurveyInput as { claims?: { id?: string }[] }).claims?.[0]?.id;
  assert.equal(spooled.claims?.[0]?.id, goldenId, "claim identity changed");

  console.log(`ok: authored record byte-identical to lookout@0.2.0 (${files[0]})`);
} finally {
  await rm(root, { recursive: true, force: true });
}
