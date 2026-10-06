/**
 * Runs in a checkout of campfit origin/main (Traverse 4.1.0, Forage 1.0.0) and
 * writes snapshots the way that code writes them, for the Traverse 5 upgrade's
 * backward-compatibility check.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPreparedArtifact, prepareAndChunk } from "@kontourai/traverse";
import { buildSnapshotSourceRef, createFilesystemSnapshotStore, fetchSource, type Snapshot } from "@kontourai/traverse/fetch";
import { fetchSource as forageFetchSource } from "@kontourai/forage/fetch";

const OUT = process.argv[2]!;
const WRITER = process.cwd();
const { createSupabaseSnapshotStore } = await import(path.join(WRITER, "lib/ingestion/supabase-snapshot-store.ts"));
const traverseVersion = JSON.parse(readFileSync(path.join(WRITER, "node_modules/@kontourai/traverse/package.json"), "utf8")).version;

/** Supabase Storage stand-in that records every object exactly as the store uploaded it. */
const objects: Record<string, string> = {};
const storage = {
  getBucket: async () => ({ data: {}, error: null }),
  createBucket: async () => ({ data: {}, error: null }),
  from: () => ({
    upload: async (p: string, body: string) => { objects[p] = body; return { data: { path: p }, error: null }; },
    list: async (prefix: string) => ({ data: Object.keys(objects).filter((k) => k.startsWith(`${prefix}/`)).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null }),
    download: async (p: string) => (objects[p] === undefined ? { data: null, error: { message: "not found", status: 404 } } : { data: new Blob([objects[p]!]), error: null }),
  }),
};
const supabase = createSupabaseSnapshotStore({ storage });
mkdirSync(path.join(OUT, "fs"), { recursive: true });
const fsStore = createFilesystemSnapshotStore({ root: path.join(OUT, "fs") });

const utf8Html = "<html><body><main><h1>Pine Ridge</h1><p>Ages 8 - 10</p><p>Price: $3,850</p></main></body></html>";
const latin1Html = "<html><body><main><h1>Pine Ridge</h1><p>Ages 8 - 10</p><p>Café du camp: $3,850</p></main></body></html>";
const pages = [
  { id: "v4-utf8", html: utf8Html, bytes: new TextEncoder().encode(utf8Html), contentType: "text/html; charset=utf-8" },
  { id: "v4-latin1", html: latin1Html, bytes: Uint8Array.from([...latin1Html].map((c) => c.codePointAt(0)!)), contentType: "text/html; charset=iso-8859-1" },
];

const records: unknown[] = [];
for (const page of pages) {
  const result = await fetchSource(
    { id: page.id, url: `https://v4.example.test/${page.id}`, respectRobots: false, retries: 0 },
    {
      clock: () => "2026-10-01T12:00:00.000Z",
      sleep: async () => {},
      fetch: async () => new Response(page.bytes.slice(), { status: 200, headers: { "content-type": page.contentType } }),
    },
  );
  const snapshot = result.snapshot as Snapshot;
  await fsStore.put(snapshot);
  await supabase.put(snapshot);
  const snapshotRef = buildSnapshotSourceRef(snapshot);
  const prepared = prepareAndChunk(snapshot.body, snapshot.contentType);
  if (prepared.error !== undefined) throw new Error(prepared.error);
  const preparedArtifact = createPreparedArtifact(prepared.fullText, { preparationMode: "markdown", sourceSnapshotRef: snapshotRef });
  records.push({ writer: "traverse.fetchSource", id: page.id, snapshotRef, bodyHash: snapshot.bodyHash, preparedArtifact, preparedText: prepared.fullText, body: snapshot.body });
}

// Lookout's CHECK path: a Forage 1.0 capture put into CampFit's Supabase store.
{
  const page = pages[1]!;
  const result = await forageFetchSource(
    { id: "v4-forage-latin1", url: "https://v4.example.test/forage-latin1", respectRobots: false, retries: 0 } as never,
    {
      clock: () => "2026-10-01T12:00:00.000Z",
      sleep: async () => {},
      fetch: async () => new Response(page.bytes.slice(), { status: 200, headers: { "content-type": page.contentType } }),
    } as never,
  );
  const snapshot = (result as { snapshot?: Snapshot }).snapshot;
  if (!snapshot) throw new Error(`forage fetch failed: ${JSON.stringify(result)}`);
  await supabase.put(snapshot);
  records.push({ writer: "forage.fetchSource", id: "v4-forage-latin1", snapshotRef: buildSnapshotSourceRef(snapshot), bodyHash: snapshot.bodyHash, body: snapshot.body });
}

writeFileSync(path.join(OUT, "supabase-objects.json"), `${JSON.stringify(objects, null, 2)}\n`);
writeFileSync(path.join(OUT, "records.json"), `${JSON.stringify({ traverseVersion, records }, null, 2)}\n`);
console.log(JSON.stringify({ traverseVersion, records: records.map((r) => ({ id: (r as { id: string }).id, bodyHash: (r as { bodyHash: string }).bodyHash })) }, null, 2));
