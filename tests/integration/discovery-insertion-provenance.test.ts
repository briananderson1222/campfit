import { createHash } from "node:crypto";
import { prepareContent } from "@kontourai/traverse";
import { buildSnapshotSourceRef, createInMemorySnapshotStore, parseSnapshotSourceRef, type Snapshot } from "@kontourai/traverse/fetch";
import { describe, expect, it } from "vitest";
import { buildDiscoveryFieldSources, type DiscoveredCampStub } from "@/lib/ingestion/llm-discovery";

const body = '<main><article><h2>River Makers</h2><p>Build boats and explore moving water.</p><a href="/programs/river-makers">Learn more</a></article></main>';
const prepared = prepareContent(body, "html", 32_000).text!;
const nameExcerpt = "River Makers";
const detailUrlExcerpt = "[Learn more](/programs/river-makers)";
const snippetExcerpt = "Build boats and explore moving water.";
const locatorFor = (excerpt: string) => {
  const start = prepared.indexOf(excerpt);
  if (start < 0) throw new Error(`Fixture excerpt missing: ${excerpt}`);
  return `chars:${start}-${start + excerpt.length}`;
};
const snapshot: Snapshot = {
  sourceId: "campfit-discovery:https://example.test/programs",
  url: "https://example.test/programs",
  fetchedAt: "2026-07-10T00:00:00.000Z",
  status: 200,
  contentType: "html",
  body,
  bodyHash: createHash("sha256").update(body).digest("hex"),
};
const traceableStub: DiscoveredCampStub = {
  name: "River Makers",
  detailUrl: "https://example.test/programs/river-makers",
  snippet: "Build boats and explore moving water.",
  excerpt: snippetExcerpt,
  locator: locatorFor(snippetExcerpt),
  nameExcerpt,
  nameLocator: locatorFor(nameExcerpt),
  detailUrlExcerpt,
  detailUrlLocator: locatorFor(detailUrlExcerpt),
  sourceUrl: "https://example.test/programs",
  sourceRef: buildSnapshotSourceRef(snapshot),
};

describe("discovery insertion provenance", () => {
  it("builds field-specific unapproved name and website observations from a traceable stub", () => {
    const sources = buildDiscoveryFieldSources(traceableStub);
    expect(sources).toEqual({
      name: {
        excerpt: traceableStub.nameExcerpt,
        locator: traceableStub.nameLocator,
        sourceUrl: traceableStub.sourceUrl,
        sourceRef: traceableStub.sourceRef,
      },
      websiteUrl: {
        excerpt: traceableStub.detailUrlExcerpt,
        locator: traceableStub.detailUrlLocator,
        sourceUrl: traceableStub.sourceUrl,
        sourceRef: traceableStub.sourceRef,
      },
    });
    expect(sources.name).not.toHaveProperty("approvedAt");
  });

  it("round-trips every stored field observation through its snapshot and Markdown locator", async () => {
    const store = createInMemorySnapshotStore();
    await store.put(snapshot);
    const sources = buildDiscoveryFieldSources(traceableStub);
    for (const observation of Object.values(sources)) {
      const parsed = parseSnapshotSourceRef(observation.sourceRef);
      expect(parsed).toBeDefined();
      const stored = await store.get(parsed!.sourceId, parsed!.bodyHash);
      expect(stored).toBeDefined();
      expect(stored!.bodyHash).toBe(snapshot.bodyHash);
      const markdown = prepareContent(stored!.body, stored!.contentType, 32_000).text!;
      const match = /^chars:(\d+)-(\d+)$/.exec(observation.locator)!;
      expect(markdown.slice(Number(match[1]), Number(match[2]))).toBe(observation.excerpt);
    }
  });

  it("fails closed before SQL when excerpt or snapshot provenance is absent", () => {
    expect(() => buildDiscoveryFieldSources({ ...traceableStub, excerpt: "" })).toThrow(/lacks verified snapshot provenance/);
    expect(() => buildDiscoveryFieldSources({ ...traceableStub, sourceRef: "https://example.test/programs" })).toThrow(/lacks verified snapshot provenance/);
    expect(() => buildDiscoveryFieldSources({ ...traceableStub, detailUrlExcerpt: null })).toThrow(/lacks verified website URL provenance/);
  });
});
