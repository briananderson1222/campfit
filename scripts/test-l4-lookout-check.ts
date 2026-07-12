import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createObservationStore } from "@kontourai/lookout";
import { buildSnapshotSourceRef, type Snapshot, type SnapshotStore } from "@kontourai/traverse/fetch";
import { campToLookoutSource, isLookoutUnchanged, listingToLookoutSource, runLookoutCheck, runLookoutRecrawlForCamp } from "../lib/ingestion/lookout-check-adapter";
import type { TraverseRecrawlResult } from "../lib/ingestion/traverse-recrawl-adapter";
import type { Camp } from "../lib/types";
import { deliverRecrawlReview } from "../lib/ingestion/crawl-pipeline";

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

// E6 threat matrix: the common live CHECK boundary mediates the first attempt
// (and therefore the shell-warning retry, which calls the same runner).
for (const threat of [
  { name: "private-literal", url: "http://127.0.0.1/", answers: {} },
  { name: "dns-private", url: "https://private.test/", answers: { "private.test": [{ address: "10.0.0.8", family: 4 }] } },
] as const) {
  const threatSource = campToLookoutSource({ id: `threat-${threat.name}`, websiteUrl: threat.url });
  const checked = await runLookoutCheck(threatSource, {
    store: { ...store, latest: async () => undefined },
    egressResolver: async (host) => [...(threat.answers[host as keyof typeof threat.answers] ?? [])],
    fetchSource: async (config, fetchOptions) => {
      try { await fetchOptions?.fetch?.(config.url, { method: "GET", headers: {}, redirect: "manual", signal: new AbortController().signal }); }
      catch { return { error: { kind: "network", message: "policy-rejected" } }; }
      return { error: { kind: "network", message: "unexpected-connection" } };
    },
  });
  assert.equal(checked.kind, "error", `${threat.name} is rejected as a stable CHECK error`);
}

{
  const responseOracle = { responses: [{ status: 302, headers: { location: "http://169.254.169.254/latest" } }] };
  const redirectSource = campToLookoutSource({ id: "threat-redirect", websiteUrl: "https://public.test/" });
  await runLookoutCheck(redirectSource, {
    store: { ...store, latest: async () => undefined },
    egressResolver: async (host) => host === "public.test" ? [{ address: "93.184.216.34", family: 4 }] : [],
    fetchOptions: { egressResponseOracle: responseOracle } as never,
    fetchSource: async (config, fetchOptions) => {
      try { await fetchOptions?.fetch?.(config.url, { method: "GET", headers: {}, redirect: "manual", signal: new AbortController().signal }); } catch { return { error: { kind: "network", message: "policy-rejected" } }; }
      return { error: { kind: "network", message: "unexpected" } };
    },
  });
}

const shellPolicy = campToLookoutSource({ id: "shell", websiteUrl: "https://shell.test" }, "on-shell-warning");
await runLookoutCheck(shellPolicy, { store: { ...store, latest: async () => undefined }, fetchSource: async (config) => {
  assert.notEqual(config.render, true, "on-shell-warning must begin with a plain classified attempt");
  assert.equal(config.revalidate, true);
  return { error: { kind: "network", message: "plain-fixture" } };
} });

// Production coordinator: a plain classified snapshot whose replay reports a
// JS shell warning must cause exactly one second, rendered classification and
// extract exclusively from that rendered classified ref.
{
  const sourceId = "shell-retry-camp";
  const plain: Snapshot = { ...snapshot, sourceId, url: "https://shell-retry.test", body: "shell", bodyHash: "shell-hash", fetchedAt: "2026-07-11T03:00:00.000Z" };
  const renderedSnapshot: Snapshot = { ...plain, body: "rendered", bodyHash: "rendered-hash", fetchedAt: "2026-07-11T03:01:00.000Z" };
  let latestShell: Snapshot | undefined;
  const shellStore: SnapshotStore = { latest: async () => latestShell, get: async () => latestShell, list: async () => latestShell ? [latestShell] : [], put: async (next) => { latestShell = next; } };
  const classifiedModes: boolean[] = [];
  const replayedRefs: string[] = [];
  const result = await runLookoutRecrawlForCamp({
    campId: sourceId, websiteUrl: plain.url, campName: "Shell Camp",
    current: { id: sourceId, websiteUrl: plain.url, name: "Shell Camp" } as unknown as Camp,
    provider: { name: "fixture", extract: async () => ({ proposals: [], raw: { response: "{}", model: "fixture" } }) },
    store: shellStore, fetchOptions: { renderImpl: async () => ({ html: "rendered" }) as never },
  }, {
    observationStore: createObservationStore({ root: path.join(await mkdtemp(path.join(os.tmpdir(), "campfit-shell-observation-")), "observations") }),
    fetchSource: async (config) => {
      const isRendered = config.render === true;
      classifiedModes.push(isRendered);
      return { snapshot: isRendered ? renderedSnapshot : plain };
    },
    replayCamp: async () => {
      const ref = buildSnapshotSourceRef(latestShell!);
      replayedRefs.push(ref);
      const shell = latestShell?.bodyHash === plain.bodyHash;
      return { ok: true, error: null, proposedChanges: {}, overallConfidence: 0, model: "fixture", rawExtraction: { itemIndex: 0, itemName: "Shell Camp", proposals: [{ fieldPath: "items[].name", candidateValue: "Shell Camp", confidence: 0.9, provenance: { excerpt: "Shell Camp", locator: "chars:0-10" }, extractor: "fixture", pathIndices: [0] }] }, matchedItemName: "Shell Camp", itemCount: 1, snapshot: { ref, bodyHash: latestShell!.bodyHash }, tokensUsed: 1, providerCalls: 1, latencyMs: 1, warnings: shell ? ["js-shell-suspected:fixture"] : [] };
    },
  });
  assert.equal(result.ok, true, result.error ?? "shell-warning retry failed");
  assert.deepEqual(classifiedModes, [false, true], "shell warning causes exactly one second classified rendered attempt");
  assert.equal(replayedRefs.at(-1), buildSnapshotSourceRef(renderedSnapshot), "extraction uses the rendered classified snapshot ref");
  assert.equal(result.snapshot.ref, buildSnapshotSourceRef(renderedSnapshot), "coordinator returns the rendered classified extraction");
}

// First enablement can classify unchanged because Traverse already owns a
// snapshot corpus. The coordinator must seed Lookout from that exact snapshot,
// emit nothing, then let the next changed snapshot emit normally.
const baselineRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-l4-baseline-"));
try {
  const sourceId = "baseline-camp";
  let latest: Snapshot = { ...snapshot, sourceId, url: "https://baseline.test", body: "Old", bodyHash: "old-hash", fetchedAt: "2026-07-11T00:00:00.000Z" };
  const corpusStore: SnapshotStore = { latest: async () => latest, get: async () => latest, list: async () => [latest], put: async (next) => { latest = next; } };
  let phase: "baseline" | "changed" | "recovery" = "baseline";
  let replayCalls = 0;
  const replayCamp = async (): Promise<TraverseRecrawlResult> => ({
    ...(replayCalls++, {}),
    ok: true, error: null, proposedChanges: phase === "baseline" ? {
      city: { old: "Denver", new: "Boulder", confidence: 0.9, excerpt: "Boulder", sourceUrl: latest.url, mode: "update" },
    } : {}, overallConfidence: 0, model: "fixture",
    rawExtraction: { itemIndex: 0, itemName: "Baseline Camp", proposals: [{ fieldPath: "items[].name", candidateValue: phase === "baseline" ? "Old" : phase === "changed" ? "New" : "Newest", confidence: 0.9, provenance: { excerpt: phase === "baseline" ? "Old" : phase === "changed" ? "New" : "Newest", locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] }] },
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
  assert.equal(unchanged.ok, true, unchanged.error ?? "baseline failed");
  assert.equal(unchanged.notModified, undefined, "nonempty DB-current review changes must not take the pipeline freshness-only branch");
  assert.equal(unchanged.unchangedFreshness, true, "pipeline records unchanged freshness before delivering review changes");
  assert.equal(unchanged.proposedChanges.city?.old, "Denver", "DB-current Denver remains review authority on first enablement");
  assert.equal(unchanged.proposedChanges.city?.new, "Boulder", "snapshot Boulder reaches the normal proposal flow despite zero baseline events");
  let reviewSinkCalls = 0;
  const proposalId = await deliverRecrawlReview(unchanged, async () => { reviewSinkCalls++; return "proposal-boulder-denver"; });
  assert.equal(proposalId, "proposal-boulder-denver");
  assert.equal(reviewSinkCalls, 1, "production review dispatcher creates the Boulder/Denver proposal exactly once");
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

  // Production-coordinator crash recovery: a changed run advances the pointer
  // but fails publication, then a byte-identical unchanged run must publish the
  // pending batch before taking its early return.
  phase = "recovery";
  const recoverySnapshot: Snapshot = { ...next, body: "Recovery", bodyHash: "recovery-hash", fetchedAt: "2026-07-12T02:00:00.000Z" };
  const failedFinalize = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot: path.join(baselineRoot, "survey"), replayCamp,
    fetchSource: async () => ({ snapshot: recoverySnapshot }), clock: () => "2026-07-12T03:00:00.000Z",
    emissionFaults: { beforeSurveyFinalize: () => { throw new Error("injected coordinator finalize failure"); } },
  });
  assert.equal(failedFinalize.ok, false, "coordinator exposes finalize failure");
  latest = recoverySnapshot;
  const recoveredUnchanged = await runLookoutRecrawlForCamp(options, {
    observationStore, surveySpoolRoot: path.join(baselineRoot, "survey"), replayCamp,
    fetchSource: async () => ({ snapshot: recoverySnapshot }), clock: () => "2026-07-12T04:00:00.000Z",
  });
  assert.equal(recoveredUnchanged.ok, true, recoveredUnchanged.error ?? "unchanged recovery failed");
  assert.equal(recoveredUnchanged.notModified, true);
  assert.equal((await readdir(path.join(baselineRoot, "survey"))).filter((name) => name.endsWith(".json")).length, 2, "unchanged coordinator entry publishes staged pending batch");

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
