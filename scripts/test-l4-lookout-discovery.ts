import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createObservationStore, diffProposalSets, type ProposalSetObservation } from "@kontourai/lookout";
import type { ExtractionProposal, ExtractionProvider } from "@kontourai/traverse";
import { createInMemorySnapshotStore, type Snapshot } from "@kontourai/traverse/fetch";
import {
  discoverySourceId,
  discoveryEventToStub,
  listingToLookoutSource,
  persistDiscoveryEvents,
  runLookoutListingDiscovery,
  type DiscoveryPlaceholderInsert,
} from "../lib/ingestion/lookout-discovery";
import { filterNewDiscoveries } from "../lib/ingestion/llm-discovery";
import { createDiscoveryPlaceholderRepository } from "../lib/ingestion/lookout-discovery-repository";

const url = "https://fixture.example/programs";
const sourceId = discoverySourceId(url);
const priorRef = `traverse-snapshot:${encodeURIComponent(sourceId)}?url=${encodeURIComponent(url)}&sha256=${"a".repeat(64)}&fetchedAt=2026-07-10T00%3A00%3A00.000Z`;
const currentRef = `traverse-snapshot:${encodeURIComponent(sourceId)}?url=${encodeURIComponent(url)}&sha256=${"b".repeat(64)}&fetchedAt=2026-07-11T00%3A00%3A00.000Z`;

function proposals(names: readonly string[]): ExtractionProposal[] {
  return names.flatMap((name, index) => {
    const detail = `/camp-${index + 1}`;
    return [
      { fieldPath: "items[].name", candidateValue: name, confidence: 0.96, provenance: { excerpt: name, locator: `chars:${index * 100}-${index * 100 + name.length}` }, extractor: "fixture", pathIndices: [index] },
      { fieldPath: "items[].detailUrl", candidateValue: detail, confidence: 0.93, provenance: { excerpt: `[Details](${detail})`, locator: `chars:${index * 100 + 30}-${index * 100 + 50}` }, extractor: "fixture", pathIndices: [index] },
    ];
  });
}

function observation(snapshotRef: string, names: readonly string[]): ProposalSetObservation {
  return { sourceId, snapshotRef, observedAt: "2026-07-11T00:00:00.000Z", proposals: proposals(names) };
}

const prior = observation(priorRef, ["Alder Hiking", "Beacon Art"]);
const current = observation(currentRef, ["Alder Hiking", "Beacon Art", "Cedar Science"]);
const selectEntities = (value: ProposalSetObservation) => {
  const indices = [...new Set(value.proposals.map((proposal) => proposal.pathIndices?.[0]).filter((index): index is number => index !== undefined))];
  return indices.map((index) => ({ index, proposals: value.proposals.filter((proposal) => proposal.pathIndices?.[0] === index) }));
};
const diff = diffProposalSets({
  prior,
  current,
  selectEntities,
  entityIdentity: (entity) => String(entity.proposals.find((proposal) => proposal.fieldPath === "items[].name")?.candidateValue),
  proposalsFor: (entity) => entity.proposals,
  fieldIdentity: (_entity, proposal) => proposal.fieldPath,
});
assert.equal(diff.ok, true);
if (!diff.ok) throw new Error("2-to-3 fixture diff failed");
assert.equal(diff.value.events.length, 1, "2-to-3 observation must emit exactly one event");
assert.equal(diff.value.events[0]?.kind, "new-entity-appeared");

const source = listingToLookoutSource(url);
assert.equal(source.id, `campfit-discovery:${url}`, "listing ID must preserve the exact legacy lineage");
assert.deepEqual(source.targetSchema.map((field) => field.path), ["items[].name", "items[].detailUrl", "items[].snippet"]);

// E7 has its own listing-source fixture even though it intentionally shares
// the canonical runLookoutCheck boundary with E6.
{
  const rejected = await (await import("../lib/ingestion/lookout-check-adapter")).runLookoutCheck(
    listingToLookoutSource("https://listing-private.test/programs"),
    {
      store: createInMemorySnapshotStore(),
      egressResolver: async () => [{ address: "192.168.1.5", family: 4 }],
      fetchSource: async (config, fetchOptions) => {
        try { await fetchOptions?.fetch?.(config.url, { method: "GET", headers: {}, redirect: "manual", signal: new AbortController().signal }); } catch { return { error: { kind: "network", message: "policy-rejected" } }; }
        return { error: { kind: "network", message: "unexpected" } };
      },
    },
  );
  assert.equal(rejected.kind, "error");
}

const newStub = discoveryEventToStub(diff.value.events[0]!, url);
assert.equal(newStub?.name, "Cedar Science");
assert.equal(newStub?.detailUrl, "https://fixture.example/camp-3");

const rows = new Map<string, DiscoveryPlaceholderInsert>();
for (const name of ["Alder Hiking", "Beacon Art"]) rows.set(name, null as never);
const repository = {
  async insertIfNew(input: DiscoveryPlaceholderInsert): Promise<boolean> {
    // Models the production transaction contract: canonical names are read at
    // write time, then the same C2 near-duplicate rule gates insertion.
    if (filterNewDiscoveries([input.stub], [...rows.keys()]).length === 0) return false;
    rows.set(input.stub.name, input);
    return true;
  },
};
const first = await persistDiscoveryEvents(diff.value.events, url, repository);
assert.deepEqual(first, { inserted: 1, ignored: 0 });
assert.equal(rows.size, 3);
const inserted = rows.get("Cedar Science")!;
assert.equal(inserted.stub.detailUrl, "https://fixture.example/camp-3");
assert.equal(inserted.fieldSources.name.excerpt, "Cedar Science");
assert.match(inserted.fieldSources.name.locator, /^chars:\d+-\d+$/);
assert.equal(inserted.fieldSources.name.sourceRef, currentRef);
assert.equal(inserted.fieldSources.websiteUrl.sourceUrl, url);

const replay = await persistDiscoveryEvents(diff.value.events, url, repository);
assert.deepEqual(replay, { inserted: 0, ignored: 1 }, "replaying v2 must insert zero rows");
assert.equal(rows.size, 3);

const wrongLineage = { ...diff.value.events[0]!, current: diff.value.events[0]!.kind === "new-entity-appeared" ? diff.value.events[0]!.current.map((item) => ({ ...item, sourceId: "camp:wrong" })) : [] };
assert.equal(discoveryEventToStub(wrongLineage, url), null, "wrong source lineage must fail closed");

// Production adapter proof: the idempotent DB transaction commits before the
// observation advances. Observation failure is recovered by redelivery.
function recordingPool(failCommit = false) {
  const calls: string[] = [];
  const names = new Set(["Alder Hiking", "Beacon Art"]);
  let stagedName: string | null = null;
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push(sql);
      if (sql === "COMMIT") {
        if (failCommit) throw new Error("commit-fault");
        if (stagedName) names.add(stagedName);
        stagedName = null;
      }
      if (sql === "ROLLBACK") stagedName = null;
      if (sql.includes('SELECT name FROM "Camp"')) return { rows: [...names].map((name) => ({ name })), rowCount: names.size };
      if (sql.includes('INSERT INTO "Camp"')) {
        const name = String(params?.[0]);
        if (names.has(name)) return { rows: [], rowCount: 0 };
        stagedName = name;
        return { rows: [{ id: "camp-new" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push("RELEASE"); },
  };
  return { calls, pool: { connect: async () => client } };
}

const transactional = recordingPool();
const productionRepository = createDiscoveryPlaceholderRepository(transactional.pool as never, { providerId: "provider", communitySlug: "denver", city: "Denver" });
let observationCalls = 0;
const transactionResult = await productionRepository.recordObservationAndInsert!([inserted], async () => {
  observationCalls++;
  assert.equal(transactional.calls.at(-1), "COMMIT", "observation advances only after DB commit");
});
assert.deepEqual(transactionResult, { inserted: 1, ignored: 0 });
assert.equal(observationCalls, 1);
assert.ok(transactional.calls.indexOf("COMMIT") < transactional.calls.indexOf("RELEASE"));

const observationFailure = recordingPool();
const callbackRepository = createDiscoveryPlaceholderRepository(observationFailure.pool as never, { providerId: null, communitySlug: "denver", city: null });
await assert.rejects(
  callbackRepository.recordObservationAndInsert!([inserted], async () => { throw new Error("observation-fault"); }),
  /observation-fault/,
);
assert.ok(observationFailure.calls.includes("COMMIT"), "camp is durable before observation failure");

let caughtUp = 0;
const retryResult = await callbackRepository.recordObservationAndInsert!([inserted], async () => { caughtUp++; });
assert.deepEqual(retryResult, { inserted: 0, ignored: 1 }, "redelivery no-ops the already committed camp");
assert.equal(caughtUp, 1, "redelivery advances the observation exactly once");
assert.equal(observationFailure.calls.filter((call) => call.includes('INSERT INTO "Camp"')).length, 1, "exactly one camp insert is attempted");

const commitFailure = recordingPool(true);
const commitFailureRepository = createDiscoveryPlaceholderRepository(commitFailure.pool as never, { providerId: null, communitySlug: "denver", city: null });
let advancedAfterFailedCommit = 0;
await assert.rejects(
  commitFailureRepository.recordObservationAndInsert!([inserted], async () => { advancedAfterFailedCommit++; }),
  /commit-fault/,
);
assert.equal(advancedAfterFailedCommit, 0, "a DB commit failure never advances the observation");
assert.ok(commitFailure.calls.includes("ROLLBACK"));

// Coordinator proof: unchanged first enablement replays the exact existing
// snapshot into a zero-event baseline. A changed call commits the camp but
// fails observation finalization; the next same-body unchanged call reconciles
// pending delivery before short-circuiting.
const coordinatorRoot = await mkdtemp(path.join(os.tmpdir(), "campfit-listing-coordinator-"));
try {
  const listingUrl = "https://coordinator.test/programs";
  const listingId = discoverySourceId(listingUrl);
  const store = createInMemorySnapshotStore();
  let body = "Alder Hiking Beacon Art";
  let providerNames = ["Alder Hiking", "Beacon Art"];
  const snap = (hash: string, fetchedAt: string): Snapshot => ({ sourceId: listingId, url: listingUrl, fetchedAt, status: 200, contentType: "html", body, bodyHash: hash });
  let currentSnapshot = snap("a".repeat(64), "2026-07-10T00:00:00.000Z");
  await store.put(currentSnapshot);
  const provider: ExtractionProvider = {
    name: "listing-fixture",
    async extract({ content }) {
      void content;
      return { proposals: providerNames.map((name, index) => ({ fieldPath: `items[${index}].name`, candidateValue: name, confidence: 0.96, provenance: { excerpt: name, locator: `chars:${index * 13}-${index * 13 + name.length}` }, extractor: "fixture" })), raw: { response: "{}", model: "listing-fixture" } };
    },
  };
  const delegate = createObservationStore({ root: path.join(coordinatorRoot, "observations") });
  let failObservation = false;
  const observationStore = {
    loadLatest: (id: string) => delegate.loadLatest(id),
    commit: async (...args: Parameters<typeof delegate.commit>) => failObservation
      ? (failObservation = false, { ok: false as const, error: { kind: "io" as const, message: "observation-fault" } })
      : delegate.commit(...args),
  };
  const camps = new Set(["Alder Hiking", "Beacon Art"]);
  const coordinatorRepository = {
    async insertIfNew(input: DiscoveryPlaceholderInsert) { if (camps.has(input.stub.name)) return false; camps.add(input.stub.name); return true; },
    async recordObservationAndInsert(inputs: DiscoveryPlaceholderInsert[], commitObservation: () => Promise<void>) {
      let inserted = 0; let ignored = 0;
      for (const input of inputs) { if (camps.has(input.stub.name)) ignored++; else { camps.add(input.stub.name); inserted++; } }
      await commitObservation();
      return { inserted, ignored };
    },
  };
  const common = { provider, store, repository: coordinatorRepository, observationStore: observationStore as never, surveyRoot: path.join(coordinatorRoot, "survey"), pendingRoot: path.join(coordinatorRoot, "pending") };
  const baseline = await runLookoutListingDiscovery(listingUrl, { ...common, fetchSource: async () => ({ snapshot: currentSnapshot }) });
  assert.equal(baseline.baseline, true); assert.equal(baseline.inserted, 0); assert.equal(baseline.unchanged, true);
  assert.deepEqual(await readdir(path.join(coordinatorRoot, "survey")).catch(() => []), []);
  body = "Alder Hiking Beacon Art Cedar Science";
  providerNames = ["Alder Hiking", "Beacon Art", "Cedar Science"];
  currentSnapshot = snap("b".repeat(64), "2026-07-11T00:00:00.000Z");
  failObservation = true;
  await assert.rejects(runLookoutListingDiscovery(listingUrl, { ...common, fetchSource: async () => ({ snapshot: currentSnapshot }) }), /Emission failed/);
  assert.equal(camps.has("Cedar Science"), true, "DB effect survives observation failure");
  const recoveredRun = await runLookoutListingDiscovery(listingUrl, { ...common, fetchSource: async () => ({ snapshot: currentSnapshot }) });
  assert.equal(recoveredRun.unchanged, true); assert.equal(camps.size, 3);
  assert.equal((await readdir(path.join(coordinatorRoot, "survey"))).filter((name) => name.endsWith(".json")).length, 1);
  const latestObservation = await delegate.loadLatest(listingId);
  assert.ok(latestObservation.ok && latestObservation.value?.snapshotRef.includes("b".repeat(64)));
} finally { await rm(coordinatorRoot, { recursive: true, force: true }); }

console.log("PASS L4 discovery: stable listing ID; DB-first durable ordering; observation catch-up; idempotent PLACEHOLDER");
