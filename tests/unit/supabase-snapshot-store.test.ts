import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildSnapshotSourceRef, fetchSource, snapshotHashBasis, type Snapshot } from "@kontourai/traverse/fetch";
import { buildSnapshotSourceRef as buildForageSnapshotRef, parseSnapshotSourceRef as parseForageSnapshotRef } from "@kontourai/forage/fetch";

import { withExactSnapshotLookup } from "@/lib/ingestion/lookout-snapshot-lookup";
import { isSnapshotIntact } from "@/lib/ingestion/snapshot-integrity";

import {
  SNAPSHOT_BUCKET,
  createSupabaseSnapshotStore,
  type SnapshotStorageClient,
} from "@/lib/ingestion/supabase-snapshot-store";

type StorageError = {
  message: string;
  status?: number;
  statusCode?: string;
};

class InMemoryStorageClient implements SnapshotStorageClient {
  readonly objects = new Map<string, string>();
  readonly createdBuckets: Array<{ id: string; options: { public: boolean } }> = [];
  getBucketCalls = 0;
  private readonly buckets = new Set<string>();

  async getBucket(id: string) {
    this.getBucketCalls += 1;
    if (this.buckets.has(id)) {
      return { data: { id }, error: null };
    }
    return {
      data: null,
      error: { message: "Bucket not found", status: 404, statusCode: "404" },
    };
  }

  async createBucket(id: string, options: { public: boolean }) {
    if (this.buckets.has(id)) {
      return {
        data: null,
        error: { message: "Bucket already exists", status: 409, statusCode: "409" },
      };
    }
    this.buckets.add(id);
    this.createdBuckets.push({ id, options });
    return { data: { name: id }, error: null };
  }

  from(bucket: string) {
    return {
      upload: async (
        path: string,
        body: string,
        _options: { contentType: string; upsert: boolean },
      ) => {
        if (!this.buckets.has(bucket)) {
          return { data: null, error: missingBucketError() };
        }
        this.objects.set(`${bucket}/${path}`, body);
        return { data: { path }, error: null };
      },
      list: async (
        prefix: string,
        options: { limit: number; offset: number; sortBy: { column: string; order: string } },
      ) => {
        if (!this.buckets.has(bucket)) {
          return { data: null, error: missingBucketError() };
        }
        const objectPrefix = `${bucket}/${prefix}/`;
        const data = [...this.objects.keys()]
          .filter((key) => key.startsWith(objectPrefix))
          .map((key) => ({ name: key.slice(objectPrefix.length) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(options.offset, options.offset + options.limit);
        return { data, error: null };
      },
      download: async (path: string) => {
        const body = this.objects.get(`${bucket}/${path}`);
        if (body === undefined) {
          return {
            data: null,
            error: { message: "Object not found", status: 404, statusCode: "404" },
          };
        }
        return { data: new Blob([body], { type: "application/json" }), error: null };
      },
    };
  }
}

function missingBucketError(): StorageError {
  return { message: "Bucket not found", status: 404, statusCode: "404" };
}

function snapshot(
  fetchedAt: string,
  overrides: Partial<Snapshot> = {},
): Snapshot {
  const body = overrides.body ?? `body fetched at ${fetchedAt}`;
  return {
    sourceId: "https://provider.example/camps?id=42&season=summer",
    url: "https://provider.example/camps/42",
    fetchedAt,
    status: 200,
    contentType: "html",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    ...overrides,
  };
}

describe("createSupabaseSnapshotStore", () => {
  it("round-trips put/latest/get/list, orders newest first, and lazily creates one private bucket", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const older = snapshot("2026-07-12T10:00:00.000Z");
    const newer = snapshot("2026-07-13T10:00:00.000Z");

    expect(storage.getBucketCalls).toBe(0);
    await store.put(older);
    await store.put(newer);

    expect(storage.createdBuckets).toEqual([
      { id: SNAPSHOT_BUCKET, options: { public: false } },
    ]);
    expect(storage.getBucketCalls).toBe(1);
    expect(await store.list(older.sourceId)).toEqual([newer, older]);
    expect(await store.latest(older.sourceId)).toEqual(newer);
    expect(await store.get(older.sourceId, older.bodyHash)).toEqual(older);
    expect([...storage.objects.keys()][0]).toContain(
      `${SNAPSHOT_BUCKET}/${encodeURIComponent(older.sourceId)}/`,
    );
  });

  it("resolves an unambiguous body-hash prefix", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const stored = snapshot("2026-07-13T10:00:00.000Z");
    await store.put(stored);

    expect(await store.get(stored.sourceId, stored.bodyHash.slice(0, 16))).toEqual(stored);
  });

  it("returns undefined for an ambiguous body-hash prefix", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    // Two real bodies whose hashes share a 3-hex-digit prefix (put() refuses a
    // record whose bodyHash is not the hash of its content).
    const byPrefix = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair; i += 1) {
      const body = `body ${i}`;
      const prefix = createHash("sha256").update(body).digest("hex").slice(0, 3);
      const seen = byPrefix.get(prefix);
      if (seen) pair = [seen, body];
      else byPrefix.set(prefix, body);
    }
    const first = snapshot("2026-07-13T10:00:00.000Z", { body: pair[0] });
    const second = snapshot("2026-07-13T11:00:00.000Z", { body: pair[1] });
    await store.put(first);
    await store.put(second);

    expect(await store.get(first.sourceId, first.bodyHash.slice(0, 3))).toBeUndefined();
    expect(await store.get(first.sourceId, first.bodyHash)).toEqual(first);
  });

  it("returns the newest snapshot when repeated crawls have the same full body hash", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const older = snapshot("2026-07-12T10:00:00.000Z", { body: "unchanged" });
    const newer = snapshot("2026-07-13T10:00:00.000Z", {
      body: older.body,
      bodyHash: older.bodyHash,
    });
    await store.put(older);
    await store.put(newer);

    expect(await store.get(older.sourceId, older.bodyHash)).toEqual(newer);
    expect(await store.get(older.sourceId, older.bodyHash.slice(0, 16))).toEqual(newer);
  });

  it("returns undefined or an empty list when the bucket or snapshot is missing", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });

    expect(await store.latest("https://missing.example")).toBeUndefined();
    expect(await store.get("https://missing.example", "deadbeef")).toBeUndefined();
    expect(await store.list("https://missing.example")).toEqual([]);
  });
});

describe("Forage 1.0 captures in the Supabase store (Lookout CHECK path)", () => {
  // A windows-1252 page: Forage 1.0 hashes the received bytes and keeps them on
  // `bytes`, with the decoded text on `body`. The store keeps the bytes as
  // base64 and must give them back as a Uint8Array, or the capture could not be
  // hashed and referenced again after a read.
  const bytes = Uint8Array.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in windows-1252
  const capture = {
    sourceId: "https://charset.example/camps",
    url: "https://charset.example/camps",
    fetchedAt: "2026-09-28T10:00:00.000Z",
    status: 200,
    contentType: "html",
    body: "Café",
    bytes,
    declaredCharset: "windows-1252",
    bodyHash: createHash("sha256").update(bytes).digest("hex"),
  } as unknown as Snapshot;

  it("reads back a byte-exact capture whose Forage reference still resolves", async () => {
    const store = createSupabaseSnapshotStore({ storage: new InMemoryStorageClient() });
    const reference = buildForageSnapshotRef(capture as never);
    await store.put(capture);

    const [readBack] = await store.list(capture.sourceId);
    expect((readBack as unknown as { bytes: unknown }).bytes).toBeInstanceOf(Uint8Array);
    expect(buildForageSnapshotRef(readBack as never)).toBe(reference);

    const lookup = parseForageSnapshotRef(reference)!;
    const found = await withExactSnapshotLookup(store).findExact(lookup);
    expect(found.kind).toBe("found");
  });

  it("exact lookup refuses a hash prefix and a mismatched envelope digest", async () => {
    const store = createSupabaseSnapshotStore({ storage: new InMemoryStorageClient() });
    await store.put(capture);
    const exact = withExactSnapshotLookup(store);
    const lookup = parseForageSnapshotRef(buildForageSnapshotRef(capture as never))!;

    expect((await exact.findExact({ ...lookup, bodyHash: lookup.bodyHash.slice(0, 16).padEnd(64, "0") })).kind).toBe("missing");
    expect((await exact.findExact({ ...lookup, snapshotDigest: "0".repeat(64) })).kind).toBe("mismatch");
    expect((await exact.findExact({ ...lookup, url: "https://charset.example/other" })).kind).toBe("mismatch");
  });

  it('exact lookup never returns a same-hash capture from a different fetch', async () => {
    const store = createSupabaseSnapshotStore({ storage: new InMemoryStorageClient() });
    const later = { ...capture, fetchedAt: '2026-09-29T10:00:00.000Z' } as unknown as Snapshot;
    const laterLookup = parseForageSnapshotRef(buildForageSnapshotRef(later as never))!;
    const exact = withExactSnapshotLookup(store);

    // Only the earlier fetch is stored: the later reference must not resolve to it.
    await store.put(capture);
    expect((await exact.findExact({ ...laterLookup, snapshotDigest: undefined })).kind).toBe('missing');

    // Both fetches stored: each reference resolves to its own capture.
    await store.put(later);
    const found = await exact.findExact(laterLookup);
    expect(found.kind).toBe('found');
    expect(found.kind === 'found' && found.snapshot.fetchedAt).toBe('2026-09-29T10:00:00.000Z');
  });
});

/**
 * Traverse 5's SnapshotStore contract (docs/decisions/text-snapshot-bytes.md in
 * @kontourai/traverse), run against CampFit's own Supabase store.
 */
describe("Traverse 5 snapshot contract in the Supabase store", () => {
  const sourceId = "https://latin1.example/camps";
  // "Café Camp" in ISO-8859-1: é is the single byte 0xE9, not valid UTF-8.
  const latin1Html = "<html><body><h1>Café Camp</h1></body></html>";
  const latin1Bytes = Uint8Array.from([...latin1Html].map((ch) => ch.codePointAt(0)!));

  /** A capture made by Traverse 5's own fetchSource, so the record has the exact shape its writer produces. */
  async function capture(bytes: Uint8Array, contentType: string, fetchedAt = "2026-10-05T10:00:00.000Z"): Promise<Snapshot> {
    const result = await fetchSource(
      { id: sourceId, url: "https://latin1.example/camps", respectRobots: false, retries: 0 },
      {
        clock: () => fetchedAt,
        sleep: async () => {},
        fetch: async () => new Response(bytes.slice(), { status: 200, headers: { "content-type": contentType } }),
      },
    );
    if (!result.snapshot) throw new Error(`fetch failed: ${JSON.stringify(result.error)}`);
    return result.snapshot;
  }

  it("stores and reads back a latin1 capture hashed by its bytes", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const latin1 = await capture(latin1Bytes, "text/html; charset=iso-8859-1");
    expect(latin1.body).toBe(latin1Html);
    expect(snapshotHashBasis(latin1)).toBe("bytes");
    expect(latin1.bodyHash).toBe(createHash("sha256").update(latin1Bytes).digest("hex"));
    expect(latin1.bodyHash).not.toBe(createHash("sha256").update(latin1Html, "utf8").digest("hex"));

    await store.put(latin1);
    const readBack = await store.get(sourceId, latin1.bodyHash);
    expect(readBack).toEqual(latin1);
    expect(isSnapshotIntact(readBack!)).toBe(true);
    expect(buildSnapshotSourceRef(readBack!)).toBe(buildSnapshotSourceRef(latin1));
  });

  it("put() throws for a record that would not read back, and stores nothing", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const latin1 = await capture(latin1Bytes, "text/html; charset=iso-8859-1");
    const legacy = snapshot("2026-07-12T10:00:00.000Z");

    const refused: Snapshot[] = [
      { ...legacy, bodyHash: "a".repeat(64) }, // placeholder hash
      { ...latin1, body: "Caf� Camp" }, // body is not the decode of its bytes
      { ...latin1, bodyHash: createHash("sha256").update(latin1.body, "utf8").digest("hex") }, // hash on the wrong basis
      { ...legacy, fetchedAt: "July 12 2026" }, // not an ISO-8601 instant
      { ...legacy, fetchedAt: "2026-07-12T10:00:00.000Z/../../other" },
    ];
    for (const record of refused) {
      await expect(store.put(record)).rejects.toBeInstanceOf(TypeError);
    }
    expect(storage.objects.size).toBe(0);
  });

  it("skips a stored record whose content no longer hashes to its bodyHash", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const latin1 = await capture(latin1Bytes, "text/html; charset=iso-8859-1");
    const older = await capture(Uint8Array.from([...latin1Bytes, 0x0a]), "text/html; charset=iso-8859-1", "2026-10-04T10:00:00.000Z");
    await store.put(older);
    await store.put(latin1);
    const key = [...storage.objects.keys()].find((name) => name.includes("2026-10-05"))!;

    // A byte changed in storage: the record is absent, and latest() falls back to the older capture.
    const stored = JSON.parse(storage.objects.get(key)!) as { bytesBase64: string };
    const damaged = Buffer.from(stored.bytesBase64, "base64");
    damaged[5] = 0x41;
    stored.bytesBase64 = damaged.toString("base64");
    storage.objects.set(key, JSON.stringify(stored));
    expect(await store.get(sourceId, latin1.bodyHash)).toBeUndefined();
    expect((await store.latest(sourceId))?.fetchedAt).toBe("2026-10-04T10:00:00.000Z");
  });

  it("reads a byte-hashed record's text from its bytes, whatever body it stored", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const latin1 = await capture(latin1Bytes, "text/html; charset=iso-8859-1");
    await store.put(latin1);
    const [key] = [...storage.objects.keys()];
    const stored = JSON.parse(storage.objects.get(key!)!) as { body: string };
    stored.body = "<html><body><h1>Rewritten</h1></body></html>";
    storage.objects.set(key!, JSON.stringify(stored));

    expect((await store.get(sourceId, latin1.bodyHash))?.body).toBe(latin1Html);
  });

  it("skips a stored pre-Traverse-5 record whose body was rewritten", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const legacy = snapshot("2026-07-12T10:00:00.000Z");
    await store.put(legacy);
    const [key] = [...storage.objects.keys()];
    const stored = JSON.parse(storage.objects.get(key!)!) as { body: string };
    stored.body = `${stored.body} (rewritten)`;
    storage.objects.set(key!, JSON.stringify(stored));

    expect(await store.get(legacy.sourceId, legacy.bodyHash)).toBeUndefined();
    expect(await store.list(legacy.sourceId)).toEqual([]);
  });

  it("orders snapshots by the instant fetchedAt names, not its text", async () => {
    const store = createSupabaseSnapshotStore({ storage: new InMemoryStorageClient() });
    // 10:00+05:00 is 05:00Z, before 06:00Z, though its text sorts after.
    const offset = snapshot("2026-07-13T10:00:00+05:00", { body: "offset" });
    const utc = snapshot("2026-07-13T06:00:00Z", { body: "utc" });
    const subSecond = snapshot("2026-07-13T06:00:00.500Z", { body: "sub-second" });
    await store.put(utc);
    await store.put(offset);
    await store.put(subSecond);

    expect((await store.list(utc.sourceId)).map((item) => item.body)).toEqual(["sub-second", "utc", "offset"]);
    expect((await store.latest(utc.sourceId))?.body).toBe("sub-second");
  });

  it("still reads a UTF-8 page's capture on the same reference as before (no bytes difference)", async () => {
    const store = createSupabaseSnapshotStore({ storage: new InMemoryStorageClient() });
    const utf8Html = "<html><body><h1>Pine Ridge</h1></body></html>";
    const utf8 = await capture(new TextEncoder().encode(utf8Html), "text/html; charset=utf-8");
    // Plain UTF-8 without a byte-order mark: the hash is the same on either basis.
    expect(utf8.bodyHash).toBe(createHash("sha256").update(utf8Html, "utf8").digest("hex"));
    await store.put(utf8);
    expect(await store.get(sourceId, utf8.bodyHash)).toEqual(utf8);
  });

  it("stores a byte-hashed text record as bytesBase64 with no body", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const latin1 = await capture(latin1Bytes, "text/html; charset=iso-8859-1");
    await store.put(latin1);
    const [stored] = [...storage.objects.values()].map((json) => JSON.parse(json) as Record<string, unknown>);
    expect(stored).toMatchObject({ bytesBase64: Buffer.from(latin1Bytes).toString("base64"), declaredCharset: "iso-8859-1", bodyHash: latin1.bodyHash });
    expect(stored).not.toHaveProperty("body");
    expect(stored).not.toHaveProperty("bytes");
  });

  it("stores a 200 KB page at about the size of its base64, not an index-keyed byte object", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    // ~200 KB of HTML with latin1 characters, so the record is byte-hashed.
    const html = `<html><body>${"<p>Café Camp: été, señor, años.</p>\n".repeat(5_800)}</body></html>`;
    const bytes = Uint8Array.from([...html].map((ch) => ch.codePointAt(0)!));
    expect(bytes.length).toBeGreaterThan(200_000);
    const page = await capture(bytes, "text/html; charset=iso-8859-1");
    await store.put(page);

    const [json] = [...storage.objects.values()];
    // base64 is 4/3 of the bytes plus a few hundred characters of fields. An
    // index-keyed object (the JSON of a raw Uint8Array) is about 13x.
    expect(json!.length / bytes.length).toBeLessThan(1.5);
    expect(json!.length / bytes.length).toBeGreaterThan(1.3);
    expect((await store.get(sourceId, page.bodyHash))?.body).toBe(html);
  });

  it("still reads a binary record written by the Traverse 4.x store, its bytes as an index-keyed object", async () => {
    const storage = new InMemoryStorageClient();
    const store = createSupabaseSnapshotStore({ storage });
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff]);
    const legacy: Snapshot = {
      sourceId, url: "https://latin1.example/brochure.pdf", fetchedAt: "2026-09-01T10:00:00.000Z",
      status: 200, contentType: "pdf", body: "", bodyBytes: pdf,
      bodyHash: createHash("sha256").update(pdf).digest("hex"),
    };
    await store.put(legacy); // creates the bucket
    storage.objects.clear();
    // Exactly what the pre-upgrade store uploaded: JSON.stringify of the snapshot.
    storage.objects.set(`${SNAPSHOT_BUCKET}/${encodeURIComponent(sourceId)}/${legacy.fetchedAt}__${legacy.bodyHash}.json`, JSON.stringify(legacy));

    const readBack = await store.get(sourceId, legacy.bodyHash);
    expect(readBack?.bodyBytes).toEqual(pdf);
    expect(isSnapshotIntact(readBack!)).toBe(true);
  });
});
