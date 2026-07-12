import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createObservationStore } from "@kontourai/lookout";
import { buildSnapshotSourceRef, type Snapshot, type SnapshotStore } from "@kontourai/traverse/fetch";
import { campToLookoutSource, isLookoutUnchanged, listingToLookoutSource, runLookoutCheck, runLookoutRecrawlForCamp } from "../lib/ingestion/lookout-check-adapter";
import type { TraverseRecrawlResult } from "../lib/ingestion/traverse-recrawl-adapter";
import type { Camp } from "../lib/types";

const known = campToLookoutSource({ id: "raw-camp-id", websiteUrl: "https://camp.test" });
assert.equal(known.id, "raw-camp-id");
assert.equal(listingToLookoutSource("https://listing.test").id, "campfit-discovery:https://listing.test");
assert.ok(known.cadenceHint);

const snapshot: Snapshot = { sourceId: known.id, url: known.url, fetchedAt: "2026-07-11T00:00:00.000Z", status: 200, contentType: "html", body: "same", bodyHash: "0967115f2813a3541eaef77de9d9d5779d9c6a3f442a8e5f55c7af8a2f4f03e1" };
const store: SnapshotStore = { latest: async () => snapshot, get: async () => snapshot, list: async () => [snapshot], put: async () => undefined };
let received: Record<string, unknown> | undefined;
const result = await runLookoutCheck(known, { store, clock: () => "2026-07-11T01:00:00.000Z", fetchSource: async (config) => { received = config as unknown as Record<string, unknown>; return { snapshot: { ...snapshot, fetchedAt: "2026-07-11T01:00:00.000Z" } }; } });
assert.equal(result.kind, "unchanged-hash");
assert.equal(isLookoutUnchanged(result), true);
assert.equal(received?.id, "raw-camp-id");
assert.equal(received?.revalidate, true);
assert.equal(typeof received?.userAgent, "string");

const rendered = campToLookoutSource({ id: "rendered", websiteUrl: "https://render.test" }, "always");
let renderAttempts = 0;
await runLookoutCheck(rendered, { store: { ...store, latest: async () => undefined }, fetchSource: async (config) => {
  renderAttempts++;
  assert.equal(config.render, true);
  assert.equal(config.revalidate, false, "rendered classified attempts must not receive HTTP validators");
  return { error: { kind: "network", message: "fixture" } };
} });
assert.equal(renderAttempts, 1, "a classified rendered attempt runs exactly once");

const shellPolicy = campToLookoutSource({ id: "shell", websiteUrl: "https://shell.test" }, "on-shell-warning");
await runLookoutCheck(shellPolicy, { store: { ...store, latest: async () => undefined }, fetchSource: async (config) => {
  assert.notEqual(config.render, true, "on-shell-warning must begin with a plain classified attempt");
  assert.equal(config.revalidate, true);
  return { error: { kind: "network", message: "plain-fixture" } };
} });

// First enablement can classify unchanged because Traverse already owns a
// snapshot corpus. The coordinator must seed Lookout from that exact snapshot,
// emit nothing, then let the next changed snapshot emit normally.
const baselineRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-baseline-"));
try {
  const sourceId = "baseline-camp";
  let latest: Snapshot = { ...snapshot, sourceId, url: "https://baseline.test", body: "Old", bodyHash: "old-hash", fetchedAt: "2026-07-11T00:00:00.000Z" };
  const corpusStore: SnapshotStore = { latest: async () => latest, get: async () => latest, list: async () => [latest], put: async (next) => { latest = next; } };
  let phase: "baseline" | "changed" = "baseline";
  let replayCalls = 0;
  const replayCamp = async (): Promise<TraverseRecrawlResult> => ({
    ...(replayCalls++, {}),
    ok: true, error: null, proposedChanges: {}, overallConfidence: 0, model: "fixture",
    rawExtraction: { itemIndex: 0, itemName: "Baseline Camp", proposals: [{ fieldPath: "items[].name", candidateValue: phase === "baseline" ? "Old" : "New", confidence: 0.9, provenance: { excerpt: phase === "baseline" ? "Old" : "New", locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] }] },
    matchedItemName: "Baseline Camp", itemCount: 1, snapshot: { ref: buildSnapshotSourceRef(latest), bodyHash: latest.bodyHash },
    tokensUsed: 1, providerCalls: 1, latencyMs: 1, warnings: [],
  });
  const observationStore = createObservationStore({ root: path.join(baselineRoot, "observations") });
  const options = {
    campId: sourceId, websiteUrl: latest.url, campName: "Baseline Camp",
    current: { id: sourceId, websiteUrl: latest.url, name: "Baseline Camp" } as unknown as Camp,
    provider: { name: "fixture", extract: async () => ({ proposals: [], raw: { response: "{}", model: "fixture" } }) }, store: corpusStore,
  };
  const unchanged = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot: path.join(baselineRoot, "survey"), replayCamp,
    fetchSource: async () => ({ snapshot: latest }), clock: () => "2026-07-11T01:00:00.000Z",
  });
  assert.equal(unchanged.ok, true, unchanged.error ?? "baseline failed"); assert.equal(unchanged.notModified, true);
  assert.ok((await observationStore.loadLatest(sourceId)).ok, "unchanged first enablement seeds observation pointer");
  assert.deepEqual(await readdir(path.join(baselineRoot, "survey")).catch(() => []), [], "baseline emits no consumer-visible survey");
  const unchangedAgain = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot: path.join(baselineRoot, "survey"), replayCamp,
    fetchSource: async () => ({ snapshot: latest }), clock: () => "2026-07-11T02:00:00.000Z",
  });
  assert.equal(unchangedAgain.ok, true);
  assert.equal(replayCalls, 1, "a seeded unchanged baseline skips replay/provider work and does not rebaseline");
  phase = "changed";
  const next: Snapshot = { ...latest, body: "New", bodyHash: "new-hash", fetchedAt: "2026-07-12T00:00:00.000Z" };
  const changed = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot: path.join(baselineRoot, "survey"), replayCamp,
    fetchSource: async () => ({ snapshot: next }), clock: () => "2026-07-12T01:00:00.000Z",
  });
  assert.equal(changed.ok, true);
  assert.equal((await readdir(path.join(baselineRoot, "survey"))).filter((name) => name.endsWith(".json")).length, 1, "first later change emits exactly one survey");

  const ambiguousReplay = async (): Promise<TraverseRecrawlResult> => ({
    ...(await replayCamp()),
    rawExtraction: { proposals: [
      { fieldPath: "items[].name", candidateValue: "One", confidence: 0.9, provenance: { excerpt: "One", locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] },
      { fieldPath: "items[].name", candidateValue: "Two", confidence: 0.9, provenance: { excerpt: "Two", locator: "chars:4-7" }, extractor: "fixture", pathIndices: [1] },
    ], itemIndex: 0, itemName: "Baseline Camp" },
  });
  const ambiguousSnapshot = { ...next, body: "Ambiguous", bodyHash: "ambiguous-hash", fetchedAt: "2026-07-13T00:00:00.000Z" };
  const ambiguous = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot: path.join(baselineRoot, "survey"), replayCamp: ambiguousReplay,
    fetchSource: async () => ({ snapshot: ambiguousSnapshot }), clock: () => "2026-07-13T01:00:00.000Z",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error ?? "", /multiple-known-camp-entities/);
} finally { await rm(baselineRoot, { recursive: true, force: true }); }

console.log("L4 Lookout CHECK/source contracts passed (plain-first; one classified render; no render validators)");
