import fs from "node:fs";
import path from "node:path";
import { createInMemorySnapshotStore, fetchSource } from "@kontourai/traverse/fetch";
import { diffProposalSets, type ProposalSetObservation } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import { runTraverseRecrawlForCamp, type TraverseRecrawlResult } from "../lib/ingestion/traverse-recrawl-adapter";
import { runLookoutRecrawlForCamp } from "../lib/ingestion/lookout-check-adapter";
import { eventsToProposedChanges, dbCurrentProposedChanges } from "../lib/ingestion/lookout-event-mapper";
import { createStubProvider } from "../tests/fixtures/traverse/stub-provider";
import type { Camp } from "../lib/types";

type Fixture = { sourceId: string; sourceUrl: string; snapshotRef: string; snapshotBodyHash: string; current: { name: string; city: string }; extracted: { city: string }; confidence: { city: number }; excerpts: { city: string } };
const ROOT = process.cwd();
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/l4-lookout-parity.json"), "utf8")) as { cases: Fixture[] };
const at = "2026-07-11T00:00:00.000Z";

function camp(f: Fixture): Camp {
  return { id: f.sourceId, slug: f.sourceId, name: f.current.name, websiteUrl: f.sourceUrl, city: f.current.city, fieldSources: {}, ageGroups: [], schedules: [], pricing: [], campTypes: [], categories: [] } as unknown as Camp;
}
function fixtureFetch(f: Fixture) {
  const html = `<html><body><h1>${f.current.name}</h1><p>${f.excerpts.city}</p></body></html>`;
  return async (url: string) => ({ status: 200, headers: { get: (name: string) => name.toLowerCase() === "content-type" ? (url.endsWith("robots.txt") ? "text/plain" : "text/html") : null }, text: async () => url.endsWith("robots.txt") ? "User-agent: *\nDisallow:" : html });
}
async function route(kind: "legacy" | "lookout", f: Fixture): Promise<TraverseRecrawlResult> {
  const current = camp(f);
  const options = { campId: f.sourceId, websiteUrl: f.sourceUrl, campName: current.name, current,
    provider: createStubProvider([
      { fieldPath: "items[].name", candidateValue: current.name, needle: current.name },
      { fieldPath: "items[].city", candidateValue: f.extracted.city, needle: f.extracted.city, confidence: f.confidence.city },
    ]), store: createInMemorySnapshotStore(), mode: "live-with-capture" as const,
    fetchOptions: { fetch: fixtureFetch(f), sleep: async () => undefined, now: () => Date.parse(at) }, now: () => Date.parse(at), fieldSources: {} };
  const original = Date.now; Date.now = () => Date.parse(at);
  try { return kind === "legacy" ? await runTraverseRecrawlForCamp(options) : await runLookoutRecrawlForCamp(options, { fetchSource, clock: () => at }); }
  finally { Date.now = original; }
}

type Comparison = { sourceId: string; extractionBodyHash: string | null; extractionRef: string | null; freshness: "changed" | "unchanged"; reviewerProjection: unknown; eventProjection: unknown };
function compare(a: Comparison, b: Comparison): string[] {
  const fields: (keyof Comparison)[] = ["sourceId", "extractionBodyHash", "extractionRef", "freshness", "reviewerProjection", "eventProjection"];
  return fields.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}
function lineage(ref: string | null) { return ref?.replace(/&fetchedAt=.*$/, "") ?? null; }
function proposal(fieldPath: string, value: unknown, excerpt: string): ExtractionProposal { return { fieldPath, candidateValue: value, confidence: 0.9, provenance: { excerpt, locator: "chars:0-3" }, extractor: "fixture", pathIndices: [0] }; }
function eventProjection(f: Fixture, mutate?: "field" | "filter") {
  const prior: ProposalSetObservation = { sourceId: f.sourceId, snapshotRef: "prior", observedAt: at, proposals: [proposal("items[].name", f.current.name, f.current.name), proposal("items[].city", f.current.city, f.current.city)] };
  const current: ProposalSetObservation = { sourceId: f.sourceId, snapshotRef: f.snapshotRef, observedAt: at, proposals: [proposal("items[].name", f.current.name, f.current.name), proposal("items[].city", f.extracted.city, f.excerpts.city)] };
  const diff = diffProposalSets({ prior, current, selectEntities: (o) => mutate === "filter" ? [] : [o.proposals], entityIdentity: () => f.sourceId, proposalsFor: (p) => p, fieldIdentity: (_p, p) => mutate === "field" ? "mutated" : p.fieldPath.replace(/^items\[\]\./, "") });
  if (!diff.ok) throw new Error(diff.error.message);
  return eventsToProposedChanges(diff.value.events, f.sourceUrl).changes;
}

const rows: string[] = [];
let failedCases = 0;
let fieldDrifts = 0;
const comparisons: Comparison[] = [];
for (const [index, f] of corpus.cases.entries()) {
  const legacy = await route("legacy", f); const lookout = await route("lookout", f);
  if (!legacy.ok || !lookout.ok) throw new Error(legacy.error ?? lookout.error ?? "fixture route failed");
  // Independent columns stop at the extraction-input boundary. Reviewer
  // projection is intentionally shared D1 DB-current policy, not independent.
  const shared = dbCurrentProposedChanges({ current: camp(f), extracted: f.extracted, confidence: f.confidence, excerpts: f.excerpts, sourceUrl: f.sourceUrl });
  const events = eventProjection(f);
  const legacyBoundary: Comparison = { sourceId: f.sourceId, extractionBodyHash: legacy.snapshot.bodyHash, extractionRef: lineage(legacy.snapshot.ref), freshness: legacy.notModified ? "unchanged" : "changed", reviewerProjection: shared, eventProjection: shared };
  const lookoutBoundary: Comparison = { sourceId: f.sourceId, extractionBodyHash: lookout.snapshot.bodyHash, extractionRef: lineage(lookout.snapshot.ref), freshness: lookout.notModified ? "unchanged" : "changed", reviewerProjection: shared, eventProjection: events };
  const drift = compare(legacyBoundary, lookoutBoundary); if (drift.length) failedCases++; fieldDrifts += drift.length; comparisons.push(lookoutBoundary);
  rows.push(`| ${index + 1} | city | \`${legacyBoundary.extractionBodyHash}\` | \`${lookoutBoundary.extractionBodyHash}\` | ${drift.length ? "differs" : "same"} | ${drift.length ? drift.join(", ") : "independent orchestration agrees through extraction input; event mapper agrees with D1 projection"} |`);
}

// Each mutation is injected into the actual comparator. A mutation is counted
// only when it makes comparison fail; the command exits nonzero otherwise.
const base = comparisons[0]!;
const mutations: Array<[string, Comparison]> = [
  ["source identity", { ...base, sourceId: `mutated-${base.sourceId}` }],
  ["snapshot lineage", { ...base, extractionRef: `mutated-${base.extractionRef}` }],
  ["freshness classification", { ...base, freshness: "unchanged" }],
  ["event field identity", { ...base, eventProjection: eventProjection(corpus.cases[0]!, "field") }],
  ["event filtering", { ...base, eventProjection: eventProjection(corpus.cases[0]!, "filter") }],
];
const killed = mutations.filter(([, mutated]) => compare(base, mutated).length > 0).length;
const mutationFailures = mutations.length - killed;

const localRoot = path.join(ROOT, ".kontourai/campfit/snapshots");
const localCount = fs.existsSync(localRoot) ? fs.readdirSync(localRoot, { recursive: true }).filter((n) => String(n).endsWith(".json")).length : 0;
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(ROOT, outputIndex >= 0 && process.argv[outputIndex + 1] ? process.argv[outputIndex + 1] : ".kontourai/flow-agents/l4-cutover/parity-report.md");
const totalFailures = failedCases + mutationFailures;
const markdown = `# L4 Lookout parity report\n\n## Aggregate\n\n- Fixture corpus: \`tests/fixtures/l4-lookout-parity.json\`\n- Replayable sanitized fixtures: ${corpus.cases.length}\n- Compared cases: ${rows.length}\n- same cases: ${rows.length - failedCases}\n- differing cases: ${failedCases}\n- Per-field/boundary drifts: ${fieldDrifts}\n- Anti-laundering mutations killed by comparator: ${killed}/${mutations.length}\n- Local snapshot records discovered: ${localCount}\n- Local snapshot + canonical DB corpus: ${process.env.TEST_DATABASE_URL ? "NOT_VERIFIED (CI/database run required)" : "NOT_VERIFIED (TEST_DATABASE_URL absent)"}\n\nLegacy and Lookout are independently orchestrated over identical fixture bytes only through the extraction-input boundary: body hash, snapshot lineage/reference, and freshness classification. Freshness is derived from each route's actual \`notModified\` result. The reviewer-projection column deliberately shares the D1 DB-current core by design. It is not evidence of independent diff implementations.\n\n## Drift guard\n\nFor every fixture, native Lookout events pass through \`eventsToProposedChanges\` and are compared field-by-field (including mode) with the D1 DB-current projection for the same extraction. This is the production contract consumer for event filtering and field mapping.\n\n## Per-field parity\n\n| camp ordinal | field | legacy extraction hash | Lookout extraction hash | verdict | justification |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n## Risk-1 decision\n\nLookout CHECK/observations own classification, zero-event baseline, Survey, and discovery. Reviewer changes use the shared D1 DB-current projection, including unchanged first enablement, and are never relabeled event-derived.\n\n## Removals\n\nNo removal appeared. Removals remain report-only.\n`;
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, markdown);
console.log(`wrote ${output}; ${failedCases} differing cases (${fieldDrifts} field/boundary drifts); mutations ${killed}/${mutations.length} killed`);
if (totalFailures) process.exitCode = 1;
