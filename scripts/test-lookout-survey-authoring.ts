/**
 * Pins the authored trust record across the Lookout 0.2.0 -> 0.3.x cutover.
 *
 * The fixture was produced by lookout@0.2.0's `createSurveyEmitter` before the
 * cutover. `authorDriftSurveyInput` now does that authoring in-repo, and this
 * asserts the published record is byte-identical.
 *
 * Since Lookout 0.7 the emitter resolves every snapshot reference through the
 * snapshot store before it diffs, so the golden's "snapshot:one"/"snapshot:two"
 * references can no longer travel through a live emission. The authoring step
 * is therefore driven directly, with the golden's own prior observation id,
 * over Lookout's diff of the same proposals — the same inputs the emitter
 * hands it. (Lookout 0.6 also changed how a NEW observation id is computed;
 * that is Lookout's documented v2 record format, not an authoring change.)
 *
 * Why byte-identical rather than "looks right": the observation ID is a hash
 * over the source, the prior observation, the current snapshot and the event.
 * A different hash forks the lineage of every existing source, and it would do
 * so without failing anything — the records would still validate, still spool,
 * still review. Nothing but this comparison would notice.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffProposalSets } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import type { SurveyInput } from "@kontourai/survey";
import { authorDriftSurveyInput } from "../lib/ingestion/lookout-survey-authoring";
import { persistSurveyInput } from "../lib/ingestion/lookout-observation-store";

const golden = JSON.parse(
  await readFile(path.join(process.cwd(), "tests/fixtures/lookout-survey-authoring-golden.json"), "utf8"),
) as { spooledSurveyInput: unknown; eventCount: number };

const source = { id: "camp-1", url: "https://camp.test", kind: "web-page" as const, targetSchema: [], cadenceHint: "test", renderPolicy: "never" as const };
const proposal = (value: string, excerpt: string): ExtractionProposal => ({
  fieldPath: "items[].name", candidateValue: value, confidence: 0.91,
  provenance: { excerpt, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0],
});
const goldenInput = golden.spooledSurveyInput as { candidateSets: { metadata: { priorObservationId: string } }[] };
const priorObservationId = goldenInput.candidateSets[0]!.metadata.priorObservationId;

const diffed = diffProposalSets<readonly ExtractionProposal[]>({
  prior: { sourceId: source.id, snapshotRef: "snapshot:one", observedAt: "2026-07-11T00:00:00.000Z", proposals: [proposal("Old", "Old")] },
  current: { sourceId: source.id, snapshotRef: "snapshot:two", observedAt: "2026-07-11T01:00:00.000Z", proposals: [proposal("New", "New")] },
  selectEntities: (observation) => [observation.proposals],
  entityIdentity: () => "camp-1",
  proposalsFor: (proposals) => proposals,
  fieldIdentity: (_proposals, item) => item.fieldPath.replace(/^items\[\]\./, ""),
});
assert.equal(diffed.ok, true, "diff");
if (!diffed.ok) throw new Error("unreachable");
assert.equal(diffed.value.events.length, golden.eventCount, "event count matches the pre-cutover run");

// Same transform emitCampfitObservation applies.
const authored = authorDriftSurveyInput({
  source,
  prior: { observationId: priorObservationId, snapshotRef: "snapshot:one" },
  current: { snapshotRef: "snapshot:two", observedAt: "2026-07-11T01:00:00.000Z" },
  events: diffed.value.events,
  generatedAt: "2026-07-11T12:00:00.000Z",
  transform: (survey) => ({
    ...survey,
    claims: survey.claims.map((claim) => ({ ...claim, subjectType: "campfit.camp", subjectId: "camp-1" })),
  }) as SurveyInput,
});
assert.ok(authored, "a changed diff authors a record");
// Spooled exactly as the emitter publishes it (canonical JSON, content-hashed name).
const spoolRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-authoring-"));
let spooled: { claims?: { id?: string }[] };
try {
  const written = await persistSurveyInput(authored, spoolRoot);
  spooled = JSON.parse(await readFile(written.path, "utf8"));
} finally {
  await rm(spoolRoot, { recursive: true, force: true });
}
assert.deepEqual(spooled, golden.spooledSurveyInput, "authored record drifted from the pre-cutover output");
const goldenId = (golden.spooledSurveyInput as { claims?: { id?: string }[] }).claims?.[0]?.id;
assert.equal(spooled.claims?.[0]?.id, goldenId, "claim identity changed");

console.log("ok: authored record byte-identical to lookout@0.2.0");
