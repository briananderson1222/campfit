/**
 * Lookout CHECK and the known-camp Lookout coordinator over CampFit's real
 * snapshot stores (Traverse 5's filesystem store and the Supabase store over
 * an in-memory storage client), with captures made by Forage's real
 * fetchSource behind the egress oracle. No network, no model.
 *
 * Covers what Lookout 0.8.8's fromTraverseSnapshotStore was adopted for: a
 * Forage capture now stores into a Traverse 5 store and reads back, and the
 * trust rules around it: Lookout keeps its own source ids, and an unchanged
 * CHECK skips extraction only when its capture is the content the latest
 * observation was made from.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createObservationStore } from "@kontourai/lookout";
import type { ExtractionProposal, ExtractionProvider } from "@kontourai/traverse";
import { createFilesystemSnapshotStore, parseAnySnapshotSourceRef, type FetchSourceOptions, type SnapshotStore } from "@kontourai/traverse/fetch";
import { fetchSource as forageFetchSource } from "@kontourai/forage/fetch";
import { toForageFetchOptions } from "@kontourai/traverse/fetch";

import { campToLookoutSource, runLookoutCheck, runLookoutRecrawlForCamp } from "@/lib/ingestion/lookout-check-adapter";
import { emitCampfitObservation } from "@/lib/ingestion/lookout-observation-store";
import { createSupabaseSnapshotStore, type SnapshotStorageClient } from "@/lib/ingestion/supabase-snapshot-store";
import { runTraverseRecrawlForCamp } from "@/lib/ingestion/traverse-recrawl-adapter";
import type { EgressResolver, EgressResponseOracle } from "@/lib/security/egress-url-policy";
import type { Camp } from "@/lib/types";

/** Writable Supabase Storage stand-in: objects kept as the JSON strings the store uploads. */
function memoryStorage(): SnapshotStorageClient {
  const objects = new Map<string, string>();
  return {
    getBucket: async () => ({ data: {}, error: null }),
    createBucket: async () => ({ data: {}, error: null }),
    from: () => ({
      upload: async (key: string, body: string) => { objects.set(key, body); return { data: { path: key }, error: null }; },
      list: async (prefix: string, options: { limit: number; offset: number }) => ({
        data: [...objects.keys()].filter((key) => key.startsWith(`${prefix}/`)).map((key) => ({ name: key.slice(prefix.length + 1) }))
          .sort((a, b) => a.name.localeCompare(b.name)).slice(options.offset, options.offset + options.limit),
        error: null,
      }),
      download: async (key: string) => (objects.has(key)
        ? { data: new Blob([objects.get(key)!]), error: null }
        : { data: null, error: { message: "Object not found", status: 404 } }),
    }),
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `campfit-lookout-store-${label}-`));
  roots.push(root);
  return root;
}

const STORES: Array<[string, () => Promise<SnapshotStore>]> = [
  ["filesystem", async () => createFilesystemSnapshotStore({ root: await tempRoot("fs") })],
  ["supabase", async () => createSupabaseSnapshotStore({ storage: memoryStorage() })],
];

const CAMP_URL = "https://fixture.example/day-camp";
const CAMP_NAME = "Alder Day Camp";
const resolver: EgressResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function page(status: string): string {
  return `<html><body><h1>${CAMP_NAME}</h1><p>Registration is currently ${status}.</p></body></html>`;
}

/** Traverse-shaped fetch options whose guarded fetch is answered by the egress oracle. */
function served(body: string | Uint8Array, contentType = "text/html; charset=utf-8"): FetchSourceOptions {
  const response = typeof body === "string" ? { body } : { bodyBytes: [...body] };
  return {
    sleep: async () => {},
    egressResolver: resolver,
    egressResponseOracle: {
      responses: [
        { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:", headers: { "content-type": "text/plain" }, repeat: true },
        { status: 200, ...response, headers: { "content-type": contentType }, repeat: true },
      ],
    } satisfies EgressResponseOracle,
  } as unknown as FetchSourceOptions;
}

// A GIF: Forage keeps it as bytes, Traverse resolves its content type to text.
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x3b]);

function check(store: SnapshotStore, body: string | Uint8Array, contentType?: string, id = "camp-check") {
  const source = campToLookoutSource({ id, websiteUrl: CAMP_URL });
  return runLookoutCheck(source, { store, fetchSource: forageFetchSource, fetchOptions: toForageFetchOptions(served(body, contentType)) });
}

describe.each(STORES)("Lookout CHECK through the %s store", (_label, makeStore) => {
  it("stores the first capture as a Traverse record, repeats as unchanged-hash, and reports a changed page", async () => {
    const store = await makeStore();
    const lookoutId = campToLookoutSource({ id: "camp-check", websiteUrl: CAMP_URL }).id;

    const first = await check(store, page("OPEN"));
    expect(first.kind, JSON.stringify(first)).toBe("changed");
    const stored = await store.list(lookoutId);
    expect(stored).toHaveLength(1);
    // Stored under Lookout's own source id, with the contentType Traverse 5 requires.
    expect(stored[0].contentType).toBe("html");
    expect(await store.list("camp-check")).toEqual([]);

    const repeat = await check(store, page("OPEN"));
    expect(repeat.kind).toBe("unchanged-hash");

    const changed = await check(store, page("WAITLIST"));
    expect(changed.kind).toBe("changed");
    expect(await store.list(lookoutId)).toHaveLength(2);
  });

  it("stores and re-reads a windows-1252 capture (bytes kept; the Supabase put() validator accepts it)", async () => {
    const store = await makeStore();
    const bytes = Uint8Array.from([...Buffer.from(`<p>${CAMP_NAME} Caf`, "latin1"), 0xe9, ...Buffer.from("</p>", "latin1")]);
    const first = await check(store, bytes, "text/html; charset=windows-1252");
    expect(first.kind, JSON.stringify(first)).toBe("changed");
    if (first.kind !== "changed") return;
    expect(parseAnySnapshotSourceRef(first.currentSnapshotRef)?.bodyHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    const repeat = await check(store, bytes, "text/html; charset=windows-1252");
    expect(repeat.kind).toBe("unchanged-hash");
  });

  it("the drift emitter resolves a binary capture exactly as CHECK stored it", async () => {
    const store = await makeStore();
    const checked = await check(store, GIF, "image/gif", "camp-binary");
    expect(checked.kind, JSON.stringify(checked)).toBe("changed");
    if (checked.kind !== "changed") return;
    const source = campToLookoutSource({ id: "camp-binary", websiteUrl: CAMP_URL });
    // Stored as Lookout's adapter documents: contentType "text" with the bytes on bodyBytes.
    const [stored] = await store.list(source.id);
    expect(stored.contentType).toBe("text");
    expect(stored.bodyBytes).toBeInstanceOf(Uint8Array);

    const root = await tempRoot("binary-emit");
    const proposals: ExtractionProposal[] = [{ fieldPath: "items[].name", candidateValue: CAMP_NAME, confidence: 0.9, provenance: { excerpt: CAMP_NAME, locator: "chars:0-14" }, extractor: "stub", pathIndices: [0] }];
    const emitted = await emitCampfitObservation({
      source, entityKey: "camp-binary", checkedAt: checked.checkedAt, proposals,
      observation: { sourceId: source.id, snapshotRef: checked.currentSnapshotRef, observedAt: checked.checkedAt, proposals },
      snapshotStore: store, store: createObservationStore({ root: path.join(root, "observations") }), spoolRoot: path.join(root, "survey"),
    });
    expect(emitted.ok, emitted.ok ? "" : `${emitted.error.kind}: ${emitted.error.message}`).toBe(true);
  });
});

/** A model stand-in that reads the camp's name and registration status off the prepared page. */
function countingProvider(): { provider: ExtractionProvider; calls: () => number; fail: (on: boolean) => void } {
  let calls = 0;
  let failing = false;
  const provider: ExtractionProvider = {
    name: "stub:lookout-store",
    async extract({ content }) {
      calls++;
      if (failing) throw new Error("injected provider failure");
      const status = /currently (\w+)/.exec(content)?.[1] ?? "OPEN";
      const statusExcerpt = `currently ${status}`;
      const proposals: ExtractionProposal[] = [
        { fieldPath: "items[0].name", candidateValue: CAMP_NAME, confidence: 0.9, provenance: { excerpt: CAMP_NAME, locator: `provisional:${content.indexOf(CAMP_NAME)}` }, extractor: "stub" },
        { fieldPath: "items[0].registrationStatus", candidateValue: status, confidence: 0.9, provenance: { excerpt: statusExcerpt, locator: `provisional:${content.indexOf(statusExcerpt)}` }, extractor: "stub" },
      ];
      return { proposals, raw: { response: "{}", model: "stub" } };
    },
  };
  return { provider, calls: () => calls, fail: (on) => { failing = on; } };
}

describe.each(STORES)("Lookout known-camp coordinator over the %s store", (_label, makeStore) => {
  async function harness() {
    const store = await makeStore();
    const root = await tempRoot("coordinator");
    const observationStore = createObservationStore({ root: path.join(root, "observations") });
    const surveySpoolRoot = path.join(root, "survey");
    const model = countingProvider();
    const campId = "camp-coordinator";
    const current = { id: campId, name: CAMP_NAME, websiteUrl: CAMP_URL } as unknown as Camp;
    const options = (body: string | Uint8Array, contentType?: string) => ({ campId, campName: CAMP_NAME, websiteUrl: CAMP_URL, current, provider: model.provider, store, fetchOptions: served(body, contentType) });
    const run = (body: string | Uint8Array, contentType?: string) => runLookoutRecrawlForCamp(options(body, contentType), { observationStore, surveySpoolRoot });
    const surveys = async () => (await readdir(surveySpoolRoot).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;
    const lookoutId = campToLookoutSource({ id: campId, websiteUrl: CAMP_URL }).id;
    return { store, model, campId, lookoutId, options, run, surveys };
  }

  it("replays the Lookout capture on a change, and skips the repeat with no model call", async () => {
    const h = await harness();
    const first = await h.run(page("OPEN"));
    expect(first.ok, first.error ?? "").toBe(true);
    expect(h.model.calls()).toBe(1);
    // The replay read the capture CHECK stored under the Lookout source id.
    expect(parseAnySnapshotSourceRef(first.snapshot.ref ?? "")?.sourceId).toBe(h.lookoutId);

    const repeat = await h.run(page("OPEN"));
    expect(repeat.ok, repeat.error ?? "").toBe(true);
    expect(repeat.notModified).toBe(true);
    expect(repeat.warnings).toContain("lookout:unchanged-hash");
    expect(h.model.calls()).toBe(1);
  });

  it("fails closed on a binary page, which Traverse replay cannot prepare, and never reports it unchanged", async () => {
    const h = await harness();
    const first = await h.run(GIF, "image/gif");
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/binary/i);
    const repeat = await h.run(GIF, "image/gif");
    expect(repeat.ok).toBe(false);
    expect(repeat.notModified).toBeUndefined();
    expect(h.model.calls()).toBe(0);
  });

  it("a live Traverse recrawl of the same camp does not disturb Lookout's history", async () => {
    const h = await harness();
    expect((await h.run(page("OPEN"))).ok).toBe(true);
    // The legacy coordinator fetches live and writes under the camp id.
    const legacy = await runTraverseRecrawlForCamp({ ...h.options(page("WAITLIST")), mode: "live-with-capture" });
    expect(legacy.ok, legacy.error ?? "").toBe(true);
    expect(await h.store.list(h.campId)).toHaveLength(1);
    expect(await h.store.list(h.lookoutId)).toHaveLength(1);
    const callsBefore = h.model.calls();

    const again = await h.run(page("OPEN"));
    expect(again.ok, again.error ?? "").toBe(true);
    expect(again.notModified).toBe(true);
    expect(h.model.calls()).toBe(callsBefore);
  });

  it("a Traverse capture under the Lookout source id cannot produce a false unchanged", async () => {
    const h = await harness();
    expect((await h.run(page("OPEN"))).ok).toBe(true);
    // A Traverse 5 capture of new content lands under the Lookout id (what a
    // second writer under a shared id would do). The live page now matches it,
    // so CHECK classifies unchanged against it, but no observation was made of it.
    const body = page("WAITLIST");
    const bytes = new TextEncoder().encode(body);
    await h.store.put({
      sourceId: h.lookoutId, url: CAMP_URL, fetchedAt: new Date(Date.now() + 60_000).toISOString(), status: 200, contentType: "html",
      body, bytes, declaredCharset: "utf-8", bodyHash: createHash("sha256").update(bytes).digest("hex"),
    } as never);
    const callsBefore = h.model.calls();

    const next = await h.run(body);
    expect(next.ok, next.error ?? "").toBe(true);
    expect(next.notModified).toBeUndefined();
    expect(h.model.calls()).toBe(callsBefore + 1);
    expect(await h.surveys()).toBe(1);
  });

  it("an unchanged CHECK after a failed replay extracts the change instead of skipping it", async () => {
    const h = await harness();
    expect((await h.run(page("OPEN"))).ok).toBe(true);
    h.model.fail(true);
    const failed = await h.run(page("WAITLIST"));
    expect(failed.ok).toBe(false);
    h.model.fail(false);
    const callsBefore = h.model.calls();

    // CHECK stored the WAITLIST capture before the replay failed, so this
    // classifies unchanged; the observation is still the OPEN one.
    const retried = await h.run(page("WAITLIST"));
    expect(retried.ok, retried.error ?? "").toBe(true);
    expect(retried.notModified).toBeUndefined();
    expect(retried.warnings.some((warning) => warning.startsWith("lookout:"))).toBe(false);
    expect(h.model.calls()).toBe(callsBefore + 1);
    expect(await h.surveys()).toBe(1);
  });
});

it("refuses a live Traverse recrawl that names a replay source id", async () => {
  const store = createFilesystemSnapshotStore({ root: await tempRoot("live-refusal") });
  const model = countingProvider();
  const result = await runTraverseRecrawlForCamp({
    campId: "camp-live", campName: CAMP_NAME, websiteUrl: CAMP_URL, current: { id: "camp-live" } as unknown as Camp,
    provider: model.provider, store, fetchOptions: served(page("OPEN")), mode: "live-with-capture", replaySourceId: "lookout:camp-live",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/replay-only/);
  expect(model.calls()).toBe(0);
  expect(await store.list("lookout:camp-live")).toEqual([]);
});
