/**
 * Durable, server-only Traverse snapshot persistence in Supabase Storage.
 *
 * sourceId values are encoded with encodeURIComponent. That encoding is
 * deterministic, collision-free for distinct strings, and keeps URL path
 * separators inside one Storage folder name instead of creating nested paths.
 */

import { createClient } from "@supabase/supabase-js";
import type { Snapshot, SnapshotStore } from "@kontourai/traverse/fetch";

if (typeof window !== "undefined") {
  throw new Error("supabase-snapshot-store is server-only");
}

export const SNAPSHOT_BUCKET = "crawl-snapshots";

const LIST_PAGE_SIZE = 1_000;

interface StorageErrorLike {
  message: string;
  status?: number;
  statusCode?: string;
}

interface StorageResponse<T> {
  data: T | null;
  error: StorageErrorLike | null;
}

interface SnapshotBucketClient {
  upload(
    path: string,
    body: string,
    options: { contentType: string; upsert: boolean },
  ): PromiseLike<StorageResponse<unknown>>;
  list(
    prefix: string,
    options: {
      limit: number;
      offset: number;
      sortBy: { column: string; order: string };
    },
  ): PromiseLike<StorageResponse<Array<{ name: string }>>>;
  download(path: string): PromiseLike<StorageResponse<Blob>>;
}

/** Minimal Supabase Storage surface, exported so tests can inject a network-free fake. */
export interface SnapshotStorageClient {
  getBucket(id: string): PromiseLike<StorageResponse<unknown>>;
  createBucket(
    id: string,
    options: { public: boolean },
  ): PromiseLike<StorageResponse<unknown>>;
  from(bucket: string): SnapshotBucketClient;
}

export interface SupabaseSnapshotStoreOptions {
  /** Injected by unit tests; production constructs this from server-only env. */
  storage?: SnapshotStorageClient;
  bucket?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

interface ParsedObjectName {
  name: string;
  fetchedAt: string;
  bodyHash: string;
}

function isMissingError(error: StorageErrorLike): boolean {
  return (
    error.status === 404 ||
    error.statusCode === "404" ||
    /not[ -]?found|no such (bucket|object)/i.test(error.message)
  );
}

function isAlreadyExistsError(error: StorageErrorLike): boolean {
  return (
    error.status === 409 ||
    error.statusCode === "409" ||
    /already exists|duplicate/i.test(error.message)
  );
}

function parseObjectName(name: string): ParsedObjectName | undefined {
  const match = /^(.+)__([a-f0-9]+)\.json$/.exec(name);
  if (!match) return undefined;
  return { name, fetchedAt: match[1], bodyHash: match[2] };
}

function reviveBodyBytes(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("bodyBytes" in value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const encoded = record.bodyBytes;
  if (encoded instanceof Uint8Array || typeof encoded !== "object" || encoded === null) {
    return value;
  }

  const entries = Object.entries(encoded as Record<string, unknown>)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => Number(a) - Number(b));
  if (
    entries.length === 0 ||
    entries.some(([, byte]) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)
  ) {
    return value;
  }

  return {
    ...record,
    bodyBytes: Uint8Array.from(entries.map(([, byte]) => Number(byte))),
  };
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sourceId === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.fetchedAt === "string" &&
    typeof candidate.status === "number" &&
    typeof candidate.contentType === "string" &&
    typeof candidate.body === "string" &&
    typeof candidate.bodyHash === "string" &&
    (candidate.bodyBytes === undefined || candidate.bodyBytes instanceof Uint8Array)
  );
}

function createStorageClient(opts: SupabaseSnapshotStoreOptions): SnapshotStorageClient {
  if (opts.storage) return opts.storage;

  const supabaseUrl = opts.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Supabase snapshot storage requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return client.storage as SnapshotStorageClient;
}

/** Create a durable Supabase Storage backend satisfying Traverse's SnapshotStore. */
export function createSupabaseSnapshotStore(
  opts: SupabaseSnapshotStoreOptions = {},
): SnapshotStore {
  const storage = createStorageClient(opts);
  const bucket = opts.bucket ?? SNAPSHOT_BUCKET;
  const objects = storage.from(bucket);
  let ensureBucketPromise: Promise<void> | undefined;

  /** Lazily ensure the private bucket once per store instance before its first write. */
  async function ensureSnapshotBucket(): Promise<void> {
    if (!ensureBucketPromise) {
      ensureBucketPromise = (async () => {
        const existing = await storage.getBucket(bucket);
        if (!existing.error) return;
        if (!isMissingError(existing.error)) throw existing.error;

        const created = await storage.createBucket(bucket, { public: false });
        if (created.error && !isAlreadyExistsError(created.error)) {
          throw created.error;
        }
      })().catch((error) => {
        ensureBucketPromise = undefined;
        throw error;
      });
    }
    await ensureBucketPromise;
  }

  async function listObjectNames(sourceId: string): Promise<ParsedObjectName[] | undefined> {
    const prefix = encodeURIComponent(sourceId);
    const names: ParsedObjectName[] = [];

    try {
      for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
        const result = await objects.list(prefix, {
          limit: LIST_PAGE_SIZE,
          offset,
          sortBy: { column: "name", order: "desc" },
        });
        if (result.error || !result.data) return undefined;

        for (const object of result.data) {
          const parsed = parseObjectName(object.name);
          if (parsed) names.push(parsed);
        }
        if (result.data.length < LIST_PAGE_SIZE) break;
      }
    } catch {
      return undefined;
    }

    return names;
  }

  async function readAll(sourceId: string): Promise<Snapshot[]> {
    const prefix = encodeURIComponent(sourceId);
    const objectNames = await listObjectNames(sourceId);
    if (!objectNames) return [];

    const snapshots: Snapshot[] = [];
    for (const object of objectNames) {
      try {
        const result = await objects.download(`${prefix}/${object.name}`);
        if (result.error || !result.data) continue;
        const parsed = reviveBodyBytes(JSON.parse(await result.data.text()));
        if (
          isSnapshot(parsed) &&
          parsed.sourceId === sourceId &&
          parsed.fetchedAt === object.fetchedAt &&
          parsed.bodyHash === object.bodyHash
        ) {
          snapshots.push(parsed);
        }
      } catch {
        // A missing, corrupt, or concurrently-deleted object is absent to readers.
      }
    }

    snapshots.sort((a, b) =>
      a.fetchedAt === b.fetchedAt
        ? b.bodyHash.localeCompare(a.bodyHash)
        : b.fetchedAt.localeCompare(a.fetchedAt),
    );
    return snapshots;
  }

  return {
    async put(snapshot) {
      await ensureSnapshotBucket();
      const sourcePrefix = encodeURIComponent(snapshot.sourceId);
      const objectPath = `${sourcePrefix}/${snapshot.fetchedAt}__${snapshot.bodyHash}.json`;
      const result = await objects.upload(objectPath, JSON.stringify(snapshot), {
        contentType: "application/json",
        upsert: true,
      });
      if (result.error) throw result.error;
    },

    async latest(sourceId) {
      return (await readAll(sourceId))[0];
    },

    async get(sourceId, bodyHash) {
      const snapshots = await readAll(sourceId);
      const exact = snapshots.find((snapshot) => snapshot.bodyHash === bodyHash);
      if (exact) return exact;

      const prefixMatches = snapshots.filter((snapshot) =>
        snapshot.bodyHash.startsWith(bodyHash),
      );
      const matchingHashes = new Set(prefixMatches.map((snapshot) => snapshot.bodyHash));
      return matchingHashes.size === 1 ? prefixMatches[0] : undefined;
    },

    async list(sourceId) {
      return readAll(sourceId);
    },
  } satisfies SnapshotStore;
}
