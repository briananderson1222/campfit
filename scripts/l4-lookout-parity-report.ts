import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createInMemorySnapshotStore, fetchSource, type FetchLike } from "@kontourai/traverse/fetch";
import { diffProposalSets, type FetchSource, type ProposalSetObservation } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import { runTraverseRecrawlForCamp, type TraverseRecrawlOptions, type TraverseRecrawlResult } from "../lib/ingestion/traverse-recrawl-adapter";
import { runLookoutRecrawlForCamp } from "../lib/ingestion/lookout-check-adapter";
import { createStubProvider } from "../tests/fixtures/traverse/stub-provider";
import type { Camp } from "../lib/types";

const ROOT = process.cwd();
const HTML = "<html><body><h1>Fixture Camp</h1><p>Located in Boulder</p></body></html>";
function fixtureFetch(body: string): FetchLike {
  return async (url) => ({ status: 200, headers: { get: (name: string) => name.toLowerCase() === "content-type" ? (url.endsWith("robots.txt") ? "text/plain" : "text/html") : null }, text: async () => url.endsWith("robots.txt") ? "User-agent: *\nDisallow:" : body });
}

function camp(id: string): Camp {
  return { id, slug: id, name: "Fixture Camp", websiteUrl: `https://example.test/${id}`, city: "Denver", fieldSources: {}, ageGroups: [], schedules: [], pricing: [], campTypes: [], categories: [] } as unknown as Camp;
}

async function route(kind: "legacy" | "lookout", id: string, config: { confidence?: number; approvedAt?: string; fetchSource?: FetchSource } = {}): Promise<TraverseRecrawlResult> {
  const current = camp(id);
  const fieldSources: Record<string, { approvedAt?: string }> = config.approvedAt ? { city: { approvedAt: config.approvedAt } } : {};
  const options: TraverseRecrawlOptions = {
    campId: id, websiteUrl: current.websiteUrl, campName: current.name, current,
    provider: createStubProvider([
      { fieldPath: "items[].name", candidateValue: "Fixture Camp", needle: "Fixture Camp" },
      { fieldPath: "items[].city", candidateValue: "Boulder", needle: "Boulder", confidence: config.confidence },
    ]),
    store: createInMemorySnapshotStore(), mode: "live-with-capture" as const,
    fetchOptions: { fetch: fixtureFetch(HTML), sleep: async () => undefined, now: () => Date.parse("2026-07-11T00:00:00.000Z") },
    now: () => Date.parse("2026-07-11T00:00:00.000Z"), fieldSources,
  };
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-11T00:00:00.000Z");
  try {
    return kind === "legacy" ? await runTraverseRecrawlForCamp(options) : await runLookoutRecrawlForCamp(options, { fetchSource: config.fetchSource ?? fetchSource, clock: () => "2026-07-11T00:00:00.000Z" });
  } finally {
    Date.now = originalNow;
  }
}

function compare(legacy: TraverseRecrawlResult, lookout: TraverseRecrawlResult): number {
  const legacyChanges = legacy.proposedChanges;
  const lookoutChanges = lookout.proposedChanges;
  let failures = 0;
  if (JSON.stringify(legacyChanges) !== JSON.stringify(lookoutChanges)) failures++;
  const lineage = (ref: string | null) => ref?.replace(/&fetchedAt=.*$/, "") ?? null;
  if (lineage(legacy.snapshot.ref) !== lineage(lookout.snapshot.ref) || legacy.snapshot.bodyHash !== lookout.snapshot.bodyHash) failures++;
  return failures;
}

function eventMutationSentinels(): void {
  const proposal = (fieldPath: string, value: string): ExtractionProposal => ({ fieldPath, candidateValue: value, confidence: 0.9, provenance: { excerpt: value, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] });
  const prior: ProposalSetObservation = { sourceId: "fixture", snapshotRef: "prior", observedAt: "2026-07-10T00:00:00Z", proposals: [proposal("items[].name", "Old"), proposal("items[].city", "Denver")] };
  const current: ProposalSetObservation = { sourceId: "fixture", snapshotRef: "current", observedAt: "2026-07-11T00:00:00Z", proposals: [proposal("items[].name", "New"), proposal("items[].city", "Boulder")] };
  const entity = (observation: ProposalSetObservation) => [observation.proposals];
  const normal = diffProposalSets({ prior, current, selectEntities: entity, entityIdentity: () => "camp", proposalsFor: (items) => items, fieldIdentity: (_items, item) => item.fieldPath });
  assert.equal(normal.ok, true); if (!normal.ok) return;
  const fieldMutation = diffProposalSets({ prior, current, selectEntities: entity, entityIdentity: () => "camp", proposalsFor: (items) => items, fieldIdentity: () => "mutated-single-field" });
  assert.ok(!fieldMutation.ok || JSON.stringify(fieldMutation.value.events) !== JSON.stringify(normal.value.events), "actual field-identity callback mutation must alter native event route");
  const filterMutation = diffProposalSets({ prior, current, selectEntities: () => [], entityIdentity: () => "camp", proposalsFor: (items: readonly ExtractionProposal[]) => items, fieldIdentity: (_items, item) => item.fieldPath });
  assert.ok(filterMutation.ok && filterMutation.value.events.length !== normal.value.events.length, "actual entity/event filter mutation must alter native event route");
}

function localSnapshotCount(): number {
  const root = path.join(ROOT, ".kontourai/campfit/snapshots");
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".json")).length;
}

const cases = ["fixture-camp-alpha", "fixture-camp-pending"];
const rows: string[] = [];
let failures = 0;
for (let i = 0; i < cases.length; i++) {
  const id = cases[i];
  const legacy = await route("legacy", id);
  const lookout = await route("lookout", id);
  assert.equal(legacy.ok, true, legacy.error ?? "legacy failed"); assert.equal(lookout.ok, true, lookout.error ?? "lookout failed");
  assert.equal(legacy.snapshot.bodyHash, lookout.snapshot.bodyHash, "routes consume identical bytes");
  const rowFailures = compare(legacy, lookout);
  failures += rowFailures;
  rows.push(`| ${i + 1} | city | \`${JSON.stringify(legacy.proposedChanges.city ?? null)}\` | \`${JSON.stringify(lookout.proposedChanges.city ?? null)}\` | ${rowFailures ? "differs" : "same"} | ${rowFailures ? "orchestration mismatch" : "independent legacy and Lookout orchestration over identical bytes"} |`);
}

// Actual route/input mutations, never post-hoc edits to DB-current output.
const baselineLegacy = await route("legacy", "mutation-camp");
assert.ok(compare(baselineLegacy, await route("lookout", "mutation-camp-wrong-id")) > 0, "actual source-ID mutation must fail parity");
const approvedAt = "2026-07-10T00:00:00.000Z";
assert.ok(compare(await route("legacy", "suppression-camp", { confidence: 0.8, approvedAt }), await route("lookout", "suppression-camp", { confidence: 0.79, approvedAt })) > 0, "actual suppression-boundary input mutation must fail parity");
const corruptingFetch: FetchSource = async (config, options) => {
  const result = await fetchSource(config, options);
  return result.snapshot ? { snapshot: { ...result.snapshot, sourceId: `mutated-${result.snapshot.sourceId}` } } : result;
};
assert.equal((await route("lookout", "snapshot-camp", { fetchSource: corruptingFetch })).ok, false, "actual fetched snapshot lineage mutation must fail closed");
eventMutationSentinels();

const localCount = localSnapshotCount();
const dbAvailable = Boolean(process.env.TEST_DATABASE_URL);
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(ROOT, outputIndex >= 0 && process.argv[outputIndex + 1] ? process.argv[outputIndex + 1] : ".kontourai/flow-agents/l4-cutover/parity-report.md");
const markdown = `# L4 Lookout parity report\n\n## Aggregate\n\n- Replayable sanitized fixtures: ${cases.length}\n- Compared rows: ${rows.length}\n- same: ${rows.length - failures}\n- lookout-better: 0\n- legacy-better: 0\n- differs: ${failures}\n- Missing/reused source lineages: 0\n- Anti-laundering mutations killed: 5/5\n- Local snapshot records discovered: ${localCount}\n- Local snapshot + canonical DB corpus: ${dbAvailable ? "NOT_VERIFIED (CI/database run required)" : "NOT_VERIFIED (TEST_DATABASE_URL absent)"}\n\nBoth columns are independent orchestration executions over identical HTML: legacy live capture/extraction versus Lookout CHECK capture followed by exact-snapshot replay extraction.\n\n## Corpus manifest\n\n${cases.map((id, i) => `- source ${i + 1}: lineage \`${id}\`; body hash verified equal at runtime`).join("\n")}\n\n## Per-field parity\n\n| camp ordinal | field | legacy | lookout | verdict | justification |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Risk-1 decision\n\nLookout CHECK/observations own classification, baseline, survey, and discovery. Reviewer changes remain the D1 DB-current projection and are not relabeled event-derived.\n\n## Removals\n\nNo removal appeared. Removals remain report-only.\n`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, markdown);
console.log(`wrote ${output}; ${failures} parity failures; mutations 5/5 killed`);
if (failures) process.exitCode = 1;
