/**
 * Durable, server-only Traverse snapshot persistence in Supabase Storage.
 *
 * sourceId values are encoded with encodeURIComponent. That encoding is
 * deterministic, collision-free for distinct strings, and keeps URL path
 * separators inside one Storage folder name instead of creating nested paths.
 */

import { createClient } from "@supabase/supabase-js";
import { createInMemorySnapshotStore, type Snapshot, type SnapshotStore } from "@kontourai/traverse/fetch";

import { decodedSnapshotText, snapshotIntegrityProblem } from "@/lib/ingestion/snapshot-integrity";

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

const BYTE_FIELDS = ["bodyBytes", "bytes"] as const;

/**
 * The stored JSON shape, the one Traverse 5's filesystem store writes: each
 * byte field present becomes base64 in a sibling `<field>Base64` string, and a
 * byte-hashed text record (one that carries `bytes`) is written WITHOUT
 * `body`, since its text is decoded from the bytes on read. A Uint8Array
 * given to JSON.stringify would instead become an index-keyed object, about
 * 13 times the size of the bytes; base64 is about 1.34 times.
 *
 * A record written this way has no `body`, so a reader from before Traverse 5
 * cannot read it. Nothing from before the upgrade reads this store after it
 * is deployed.
 */
function toStoredShape(snapshot: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = { ...snapshot };
  for (const field of BYTE_FIELDS) {
    const value = snapshot[field];
    if (value === undefined) continue;
    delete out[field];
    out[`${field}Base64`] = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  if (snapshot.bytes !== undefined) delete out.body;
  return out;
}

/**
 * Reverse of `toStoredShape`, and the reader for every shape already in
 * storage. A `<field>Base64` sibling must be a string (a damaged string is
 * caught by the hash check), and a record carrying both it and the raw field
 * is refused. Records written before this shape stored a byte field as an
 * index-keyed object (CampFit at Traverse 4.x: binary `bodyBytes`, and Forage
 * captures' `bytes`); those are still revived. Body-only records need no
 * conversion.
 */
function fromStoredShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  let out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of BYTE_FIELDS) {
    const key = `${field}Base64`;
    if (!(key in out)) {
      out = reviveByteField(out, field) as Record<string, unknown>;
      continue;
    }
    const encoded = out[key];
    if (typeof encoded !== "string" || field in out) return undefined;
    delete out[key];
    out[field] = new Uint8Array(Buffer.from(encoded, "base64"));
  }
  return out;
}

function reviveByteField(value: unknown, field: "bodyBytes" | "bytes"): unknown {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const encoded = record[field];
  if (encoded instanceof Uint8Array || typeof encoded !== "object" || encoded === null) {
    return value;
  }

  const entries = Object.entries(encoded as Record<string, unknown>)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => Number(a) - Number(b));
  if (
    (entries.length === 0 && Object.keys(encoded as object).length > 0) ||
    entries.some(([, byte]) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)
  ) {
    return value;
  }

  return {
    ...record,
    [field]: Uint8Array.from(entries.map(([, byte]) => Number(byte))),
  };
}

/**
 * The snapshot a stored record reads as, or `undefined` when it does not read.
 *
 * Same rule as Traverse 5's bundled stores (docs/decisions/text-snapshot-bytes.md
 * in @kontourai/traverse): a record is returned only if its content hashes to
 * its `bodyHash` on the basis its fields allow, so a damaged or rewritten
 * record is absent rather than readable with text its reference does not
 * cover. A byte-hashed text record reads with `body` decoded from its bytes,
 * whatever `body` it stored. Records written before Traverse 5 (no `bytes`)
 * are checked against the UTF-8 of their stored `body`, as before.
 */
function readRecord(value: unknown): Snapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sourceId !== "string" ||
    typeof candidate.url !== "string" ||
    typeof candidate.fetchedAt !== "string" ||
    typeof candidate.status !== "number" ||
    !Number.isFinite(candidate.status) ||
    typeof candidate.contentType !== "string" ||
    typeof candidate.bodyHash !== "string"
  ) {
    return undefined;
  }
  let snapshot = candidate as unknown as Snapshot;
  if (snapshot.bodyBytes === undefined && snapshot.bytes instanceof Uint8Array) {
    const decoded = decodedSnapshotText(snapshot);
    if (decoded === undefined) return undefined;
    snapshot = { ...snapshot, body: decoded };
  }
  return snapshotIntegrityProblem(snapshot) === null ? snapshot : undefined;
}

/**
 * Newest first by the instant `fetchedAt` names, not its text (`10:00Z` is
 * before `10:00:30Z`; `10:00+05:00` is before `06:00Z`), as Traverse 5's
 * stores order them. Digits past the millisecond still count. Ties fall back
 * to `fetchedAt` text, then `bodyHash`, both descending. A `fetchedAt` that
 * does not parse orders last.
 */
function sortNewestFirst(snapshots: Snapshot[]): Snapshot[] {
  const keyed = snapshots.map((snapshot) => {
    const ms = Date.parse(snapshot.fetchedAt);
    return {
      snapshot,
      ms: Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms,
      subMs: /\.\d{3}(\d+)/.exec(snapshot.fetchedAt)?.[1] ?? "",
    };
  });
  const desc = (a: string, b: string) => (a === b ? 0 : a < b ? 1 : -1);
  keyed.sort((a, b) => {
    if (a.ms !== b.ms) return b.ms > a.ms ? 1 : -1;
    const width = Math.max(a.subMs.length, b.subMs.length);
    const bySubMs = desc(a.subMs.padEnd(width, "0"), b.subMs.padEnd(width, "0"));
    if (bySubMs !== 0) return bySubMs;
    return a.snapshot.fetchedAt === b.snapshot.fetchedAt
      ? desc(a.snapshot.bodyHash, b.snapshot.bodyHash)
      : desc(a.snapshot.fetchedAt, b.snapshot.fetchedAt);
  });
  return keyed.map((entry) => entry.snapshot);
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
        const parsed = readRecord(fromStoredShape(JSON.parse(await result.data.text())));
        if (
          parsed !== undefined &&
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

    return sortNewestFirst(snapshots);
  }

  return {
    async put(snapshot) {
      // Traverse 5's put() contract: throw a TypeError for a snapshot that would
      // not read back unchanged (content that does not hash to bodyHash, a body
      // that is not the decode of its bytes, a fetchedAt that is not an ISO-8601
      // instant, ...). Traverse does not export that check, so it is run through
      // Traverse's own in-memory store, whose put() applies exactly it. The
      // fetchedAt check also keeps the object name below one path segment.
      await createInMemorySnapshotStore().put(snapshot);
      await ensureSnapshotBucket();
      const sourcePrefix = encodeURIComponent(snapshot.sourceId);
      const objectPath = `${sourcePrefix}/${snapshot.fetchedAt}__${snapshot.bodyHash}.json`;
      const result = await objects.upload(objectPath, JSON.stringify(toStoredShape(snapshot)), {
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
