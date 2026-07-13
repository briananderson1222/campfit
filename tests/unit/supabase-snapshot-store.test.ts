import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Snapshot } from "@kontourai/traverse/fetch";

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
    const first = snapshot("2026-07-13T10:00:00.000Z", {
      bodyHash: `abc${"1".repeat(61)}`,
    });
    const second = snapshot("2026-07-13T11:00:00.000Z", {
      body: "different body",
      bodyHash: `abc${"2".repeat(61)}`,
    });
    await store.put(first);
    await store.put(second);

    expect(await store.get(first.sourceId, "abc")).toBeUndefined();
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
