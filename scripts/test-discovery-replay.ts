import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionProposal, ExtractionProvider, ProviderExtractionOutput } from "@kontourai/traverse";
import { prepareContent } from "@kontourai/traverse";
import { createInMemorySnapshotStore, parseSnapshotSourceRef, replaySource, type FetchLike } from "@kontourai/traverse/fetch";
import { buildDiscoveryFieldSources, discoverCampsFromUrl, filterNewDiscoveries } from "../lib/ingestion/llm-discovery";
import { groupDiscoveryItems } from "../lib/ingestion/discovery-item-grouping";
import { createStubProvider, type StubProposalSpec } from "../tests/fixtures/traverse/stub-provider";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/discovery/legacy-yield-baseline.json"), "utf8")) as {
  fixtures: Array<{ fixture: string; bodySha256: string; expectedNames: string[]; expectedCount: number; isListingPage: boolean }>;
};
const SYNTHETIC = '<main><h1>Programs</h1><article><h2>River Makers</h2><p>Build boats and explore moving water.</p><a href="/programs/river-makers">Learn more</a></article><article><h2>Sky Studio</h2><p>Design kites and study weather patterns.</p><a href="https://example.test/programs/sky-studio">Program details</a></article></main>';

function sha256(body: string) { return createHash("sha256").update(body).digest("hex"); }
function fixtureBody(name: string) { return name.startsWith("inline:") ? SYNTHETIC : readFileSync(join(ROOT, name), "utf8"); }
function hdrGet(values: Record<string, string>) { return { get: (name: string) => values[name.toLowerCase()] ?? null }; }
function fixtureFetch(body: string, validators = false, return304 = false): FetchLike {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url.endsWith("/robots.txt")) return { status: 200, headers: hdrGet({ "content-type": "text/plain" }), text: async () => "User-agent: *\nDisallow:" };
    const validated = init?.headers?.["If-None-Match"] === '"fixture-v1"';
    if (return304 && validated) return { status: 304, headers: hdrGet({ etag: '"fixture-v1"', "content-type": "text/html" }), text: async () => { throw new Error("304 body read"); } };
    return { status: 200, headers: hdrGet({ "content-type": "text/html", ...(validators ? { etag: '"fixture-v1"' } : {}) }), text: async () => body };
  }) as FetchLike;
}
function specs(row: (typeof corpus.fixtures)[number]): StubProposalSpec[] {
  const names = row.expectedNames;
  if (row.fixture === "inline:synthetic-relative-links") return [
    { fieldPath: "items[0].name", candidateValue: names[0], needle: names[0] },
    { fieldPath: "items[0].detailUrl", candidateValue: "/programs/river-makers", needle: "[Learn more](/programs/river-makers)" },
    { fieldPath: "items[0].snippet", candidateValue: "Build boats and explore moving water.", needle: "Build boats and explore moving water." },
    { fieldPath: "items[1].name", candidateValue: names[1], needle: names[1] },
    { fieldPath: "items[1].detailUrl", candidateValue: "https://example.test/programs/sky-studio", needle: "[Program details](https://example.test/programs/sky-studio)" },
    { fieldPath: "items[1].snippet", candidateValue: "Design kites and study weather patterns.", needle: "Design kites and study weather patterns." },
  ];
  return names.flatMap((name, index) => [
    { fieldPath: `items[${index}].name`, candidateValue: name, needle: name },
    ...(name === "Mountain Explorers Day Camp" ? [{ fieldPath: `items[${index}].snippet`, candidateValue: "A week of hiking, climbing, and paddling for kids who love the outdoors.", needle: "A week of hiking, climbing, and paddling for kids who love the outdoors." }] : []),
    ...(name === "Junior Rangers Day Camp" ? [{ fieldPath: `items[${index}].snippet`, candidateValue: "Trail exploration, wildlife tracking, and campfire skills for older kids.", needle: "Trail exploration, wildlife tracking, and campfire skills for older kids." }] : []),
    ...(name === "Young Artists Summer Camp" ? [{ fieldPath: `items[${index}].snippet`, candidateValue: "Hands-on studio time in painting, sculpture, and printmaking led by working teaching artists in the museum studios.", needle: "Hands-on studio time in painting, sculpture, and printmaking led by working teaching artists in the museum studios." }] : []),
  ]);
}

async function characterizeCorpus() {
  const table: string[] = [];
  for (const [index, row] of corpus.fixtures.entries()) {
    const body = fixtureBody(row.fixture);
    assert.equal(sha256(body), row.bodySha256, `${row.fixture} bytes drifted`);
    const store = createInMemorySnapshotStore();
    const url = `https://example.test/listings/${index}`;
    const live = await discoverCampsFromUrl(url, { provider: createStubProvider(specs(row)), store, fetchOptions: { fetch: fixtureFetch(body), sleep: async () => {} } });
    assert.equal(live.error, undefined);
    assert.deepEqual(live.stubs.map(s => s.name), row.expectedNames);
    assert.equal(live.stubs.length, row.expectedCount);
    assert.equal(live.isListingPage, row.isListingPage, "one=false and two-or-more=true polarity");
    for (const stub of live.stubs) {
      assert.ok(stub.excerpt && /^chars:\d+-\d+$/.test(stub.locator));
      const parsed = parseSnapshotSourceRef(stub.sourceRef);
      assert.ok(parsed);
      const stored = await store.get(parsed.sourceId, parsed.bodyHash);
      assert.ok(stored, `${stub.name}: snapshot ref must resolve through store.get`);
      assert.equal(stored.bodyHash, row.bodySha256);
      const markdown = prepareContent(stored.body, stored.contentType, 64_000).text ?? "";
      const sources = buildDiscoveryFieldSources(stub);
      assert.ok(sources.name);
      assert.equal("approvedAt" in sources.name, false);
      for (const [field, observation] of Object.entries(sources)) {
        const locator = /^chars:(\d+)-(\d+)$/.exec(observation.locator);
        assert.ok(locator, `${stub.name}.${field}: locator must be parseable`);
        assert.equal(
          markdown.slice(Number(locator[1]), Number(locator[2])),
          observation.excerpt,
          `${stub.name}.${field}: locator must select the stored snapshot's exact Markdown excerpt`,
        );
      }
    }
    const replay = await discoverCampsFromUrl(url, { provider: createStubProvider(specs(row)), store, mode: "replay", fetchOptions: { fetch: async () => { throw new Error("network reached in replay"); } } });
    assert.deepEqual(replay.stubs, live.stubs);
    const stored = await replaySource(store, `campfit-discovery:${url}`);
    assert.equal(stored.snapshot?.bodyHash, row.bodySha256);
    table.push(`| ${row.fixture} | ${row.bodySha256} | ${row.expectedCount} | ${live.stubs.length} | ${row.isListingPage} | ${live.stubs.map(s => s.name).join(", ")} | pass |`);
  }
  console.log("| Fixture | Snapshot/body hash | Known programs | Traverse stubs | isListingPage | Distinct names | Provenance |");
  console.log("| --- | --- | ---: | ---: | ---: | --- | --- |");
  table.forEach(line => console.log(line));
  console.log("✓ amended AC1 corpus: 5 fixture yields and names pinned; 1=false, >=2=true; replay byte-identical and network-free");
}

async function faultAndBoundaryChecks() {
  const row = corpus.fixtures[4];
  const body = fixtureBody(row.fixture);
  const url = "https://example.test/listings/faults";
  const store = createInMemorySnapshotStore();
  const live = await discoverCampsFromUrl(url, { provider: createStubProvider(specs(row)), store, fetchOptions: { fetch: fixtureFetch(body, true), sleep: async () => {} } });
  assert.equal(live.stubs[0].detailUrl, "https://example.test/programs/river-makers");
  assert.equal(live.stubs[1].detailUrl, "https://example.test/programs/sky-studio");

  const unsafeSpecs = specs(row).map(s => s.fieldPath === "items[0].detailUrl" ? { ...s, candidateValue: "javascript:alert(1)" } : s);
  const unsafe = await discoverCampsFromUrl("https://example.test/listings/unsafe", { provider: createStubProvider(unsafeSpecs), store: createInMemorySnapshotStore(), fetchOptions: { fetch: fixtureFetch(body), sleep: async () => {} } });
  assert.equal(unsafe.stubs[0].detailUrl, null);

  const bad = await discoverCampsFromUrl("https://example.test/listings/bad", { provider: createStubProvider([{ fieldPath: "items[0].name", candidateValue: "Ghost Camp", needle: "NOT PRESENT" }]), store: createInMemorySnapshotStore(), fetchOptions: { fetch: fixtureFetch(body), sleep: async () => {} } });
  assert.equal(bad.stubs.length, 0, "non-verbatim excerpt cannot become a stub");
  assert.throws(() => buildDiscoveryFieldSources({ ...live.stubs[0], excerpt: "" }), /lacks verified snapshot provenance/);

  assert.equal(filterNewDiscoveries([live.stubs[0]], ["River Makers"]).length, 0);
  const near = { ...live.stubs[0], name: "Camp Alpha Kids" };
  const below = { ...live.stubs[0], name: "Camp Alpha Denver" };
  assert.equal(filterNewDiscoveries([near], ["Camp Alpha"]).length, 0, "score above 0.75 removed");
  assert.equal(filterNewDiscoveries([below], ["Camp Alpha"]).length, 1, "score below 0.75 retained");

  let calls = 0;
  const throwingProvider: ExtractionProvider = { name: "304-call-guard", async extract(): Promise<ProviderExtractionOutput> { calls++; throw new Error("provider called on 304"); } };
  const unchanged = await discoverCampsFromUrl(url, { provider: throwingProvider, store, revalidate: true, fetchOptions: { fetch: fixtureFetch(body, true, true), sleep: async () => {} } });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.isListingPage, true, "trustworthy 304 is unchanged listing, never not-a-listing");
  assert.equal(unchanged.error, undefined);
  assert.equal(calls, 0);
  console.log("✓ fault/boundary checks: grounded relative URLs, unsafe URL drop, non-verbatim drop, provenance insertion guard, Dice 0.75 boundary, 304 zero-provider semantics");
}

function discoveryProposal(
  fieldPath: string,
  candidateValue: string,
  itemIndex: number,
  excerpt: string,
  locatorStart: number,
): ExtractionProposal {
  return {
    fieldPath,
    candidateValue,
    confidence: 0.9,
    provenance: { excerpt, locator: `chars:${locatorStart}-${locatorStart + excerpt.length}` },
    extractor: "chunk-regression",
    pathIndices: [itemIndex],
  };
}

function crossChunkDiscoveryGroupingCheck() {
  const proposals: ExtractionProposal[] = [
    discoveryProposal("items[].name", "Alder Hiking", 0, "Alder Hiking", 10),
    discoveryProposal("items[].detailUrl", "/course-a", 0, "[Course A details](/course-a)", 20),
    discoveryProposal("items[].snippet", "Alpha excerpt", 0, "Alpha excerpt", 50),
    discoveryProposal("items[].name", "Beacon Art", 1, "Beacon Art", 100),
    discoveryProposal("items[].detailUrl", "/course-b", 1, "[Course B details](/course-b)", 110),
    discoveryProposal("items[].snippet", "Bravo excerpt", 1, "Bravo excerpt", 140),
    // This schema-invalid proposal must be filtered BEFORE the generic index
    // allocator sees it; otherwise its index 99 corrupts the next chunk's base.
    discoveryProposal("items[].ignored", "not a discovery field", 99, "not a discovery field", 170),
    // A second traverse chunk restarts its local item indices at 0 and 1,
    // while locators continue forward in the shared prepared document.
    discoveryProposal("items[].name", "Cedar Science", 0, "Cedar Science", 500),
    discoveryProposal("items[].detailUrl", "/course-c", 0, "[Course C details](/course-c)", 510),
    discoveryProposal("items[].snippet", "Charlie excerpt", 0, "Charlie excerpt", 540),
    discoveryProposal("items[].name", "Delta Music", 1, "Delta Music", 600),
    discoveryProposal("items[].detailUrl", "/course-d", 1, "[Course D details](/course-d)", 610),
    discoveryProposal("items[].snippet", "Delta excerpt", 1, "Delta excerpt", 640),
  ];

  const grouped = groupDiscoveryItems(proposals, "https://example.test/listing");
  assert.deepEqual(
    grouped.items.map(({ name, detailUrl, excerpt, locator }) => ({ name, detailUrl, excerpt, locator })),
    [
      { name: "Alder Hiking", detailUrl: "https://example.test/course-a", excerpt: "Alpha excerpt", locator: "chars:50-63" },
      { name: "Beacon Art", detailUrl: "https://example.test/course-b", excerpt: "Bravo excerpt", locator: "chars:140-153" },
      { name: "Cedar Science", detailUrl: "https://example.test/course-c", excerpt: "Charlie excerpt", locator: "chars:540-555" },
      { name: "Delta Music", detailUrl: "https://example.test/course-d", excerpt: "Delta excerpt", locator: "chars:640-653" },
    ],
    "two chunks whose local indices collide at 0/1 must preserve four ordered name/URL/excerpt/locator pairings",
  );
  assert.ok(
    grouped.warnings.some((warning) => warning.includes("items[2]") && warning.includes("rebased across a traverse chunk boundary")),
    "the first item in the second chunk must surface the canonical rebase warning at filtered global index 2",
  );
  console.log("✓ discovery cross-chunk rebasing: colliding 0/1 indices preserve 4 ordered name/URL/excerpt/locator pairings and surface the boundary warning");
}

async function discoveryDistinctnessContractCheck() {
  const discoverNames = async (names: string[], suffix: string) => {
    const body = `<main>${names.map((name) => `<h2>${name}</h2>`).join("")}</main>`;
    return discoverCampsFromUrl(`https://example.test/listings/${suffix}`, {
      provider: createStubProvider(names.map((name, index) => ({
        fieldPath: `items[${index}].name`,
        candidateValue: name,
        needle: name,
      }))),
      store: createInMemorySnapshotStore(),
      fetchOptions: { fetch: fixtureFetch(body), sleep: async () => {} },
    });
  };

  const nearDuplicates = await discoverNames(["Camp Alpha", "Camp Alpha!"], "near-duplicates");
  assert.equal(nearDuplicates.stubs.length, 1, "Dice-equivalent stubs must produce one surviving insert");
  assert.equal(nearDuplicates.isListingPage, false, "one post-dedupe survivor is not a listing page");

  const distinct = await discoverNames(["Camp Alpha", "Camp Beta"], "distinct");
  assert.equal(distinct.stubs.length, 2, "genuinely distinct stubs must produce two inserts");
  assert.equal(distinct.isListingPage, true, "two post-dedupe survivors are a listing page");
  console.log("✓ discovery distinctness: Dice-equivalent Alpha/Alpha! => 1 insert and false; distinct Alpha/Beta => 2 inserts and true");
}

function sourceGuard() {
  const source = readFileSync(join(ROOT, "lib/ingestion/llm-discovery.ts"), "utf8");
  assert.doesNotMatch(source, /callLLM|buildDiscoveryPrompt|parseDiscoveryResponse/);
  assert.doesNotMatch(source, /(?<![A-Za-z])fetch\s*\(/, "discovery must use the injected traverse fetch composition");
  assert.equal(existsSync(join(ROOT, "lib/ingestion/llm-provider.ts")), false, "retired callLLM provider path must stay deleted");
  assert.equal(readFileSync(join(ROOT, "lib/ingestion/traverse-fetch-extract.ts"), "utf8").includes('prep: "text"'), false);
  assert.match(source, /prep: "markdown"/);
  assert.match(source, /options\.mode \?\? "live-with-capture"/);
  assert.equal(readFileSync(join(ROOT, "lib/ingestion/crawl-pipeline.ts"), "utf8").includes("revalidate: true"), true);
  console.log("✓ source guard: no callLLM/bespoke prompt/parser/direct fetch; scheduled revalidation and Markdown prep retained");
}

await characterizeCorpus();
await faultAndBoundaryChecks();
crossChunkDiscoveryGroupingCheck();
await discoveryDistinctnessContractCheck();
sourceGuard();
console.log("\ndiscovery replay verification passed");
