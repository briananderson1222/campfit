/**
 * Snapshots stored before the Traverse 5 upgrade still resolve after it.
 *
 * The fixtures in tests/fixtures/traverse-4-snapshots were written by CampFit's
 * code at Traverse 4.1.0 (write-v4-snapshots.ts, run in a checkout of that
 * code): Traverse 4.1.0's filesystem store, and CampFit's Supabase store as it
 * was then, each holding one UTF-8 page and one latin1 page captured by
 * Traverse 4.1.0's fetchSource, plus a Forage 1.0 capture in the Supabase
 * store (Lookout's CHECK path). Traverse 4.1.0 hashed the UTF-8 of the decoded
 * body, so those records keep that basis and must keep resolving: a pending
 * proposal citing one is still checkable.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemSnapshotStore, parseSnapshotSourceRef, snapshotHashBasis, type SnapshotStore } from '@kontourai/traverse/fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveCitationText } from '@/lib/admin/citation-text';
import { resolveProposalSnapshot } from '@/lib/admin/shadow-auto-accept-read';
import { isSnapshotIntact } from '@/lib/ingestion/snapshot-integrity';
import { createSupabaseSnapshotStore, type SnapshotStorageClient } from '@/lib/ingestion/supabase-snapshot-store';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'traverse-4-snapshots');

interface StoredRecord {
  writer: 'traverse.fetchSource' | 'forage.fetchSource';
  id: string;
  snapshotRef: string;
  bodyHash: string;
  preparedArtifact?: unknown;
  preparedText?: string;
  body: string;
}

/** Read-only Supabase Storage stand-in serving the objects exactly as the 4.1.0 store uploaded them. */
function storageFrom(objects: Record<string, string>): SnapshotStorageClient {
  return {
    getBucket: async () => ({ data: {}, error: null }),
    createBucket: async () => ({ data: {}, error: null }),
    from: () => ({
      upload: async () => ({ data: null, error: { message: 'read-only fixture' } }),
      list: async (prefix: string) => ({
        data: Object.keys(objects).filter((key) => key.startsWith(`${prefix}/`)).map((key) => ({ name: key.slice(prefix.length + 1) })),
        error: null,
      }),
      download: async (key: string) => (objects[key] === undefined
        ? { data: null, error: { message: 'Object not found', status: 404 } }
        : { data: new Blob([objects[key]!]), error: null }),
    }),
  };
}

let root: string;
let records: StoredRecord[];
let stores: Array<[string, SnapshotStore]>;

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(path.join(FIXTURES, 'records.json'), 'utf8')) as { traverseVersion: string; records: StoredRecord[] };
  expect(manifest.traverseVersion).toBe('4.1.0');
  records = manifest.records;
  // The filesystem store is given a copy, so nothing a test does can touch the fixture.
  root = await mkdtemp(path.join(os.tmpdir(), 'campfit-traverse4-'));
  await cp(path.join(FIXTURES, 'fs'), root, { recursive: true });
  const objects = JSON.parse(await readFile(path.join(FIXTURES, 'supabase-objects.json'), 'utf8')) as Record<string, string>;
  stores = [
    ['filesystem', createFilesystemSnapshotStore({ root })],
    ['supabase', createSupabaseSnapshotStore({ storage: storageFrom(objects) })],
  ];
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('snapshots written by Traverse 4.1.0 after the upgrade', () => {
  it('reads each Traverse capture back on its UTF-8 basis, and its pending proposal still resolves', async () => {
    const traverseRecords = records.filter((record) => record.writer === 'traverse.fetchSource');
    expect(traverseRecords.map((record) => record.id)).toEqual(['v4-utf8', 'v4-latin1']);
    for (const [name, store] of stores) {
      for (const record of traverseRecords) {
        const parsed = parseSnapshotSourceRef(record.snapshotRef)!;
        const snapshot = await store.get(parsed.sourceId, parsed.bodyHash);
        expect(snapshot, `${name}:${record.id}`).toBeDefined();
        expect(snapshotHashBasis(snapshot!)).toBe('decoded-utf8');
        expect(snapshot!.body).toBe(record.body);
        expect(isSnapshotIntact(snapshot!)).toBe(true);

        // Apply's citation check: the prepared text the extraction read is reproduced exactly.
        const citation = resolveCitationText({ snapshotRef: record.snapshotRef, snapshot: snapshot!, preparedArtifact: record.preparedArtifact });
        expect(citation, `${name}:${record.id}`).toMatchObject({ ok: true, space: 'prepared', text: record.preparedText });

        // The shadow read resolves the proposal that cites it.
        const proposal = {
          snapshotRef: record.snapshotRef,
          snapshotBodyHash: record.bodyHash,
          preparedArtifact: record.preparedArtifact,
          proposedChanges: { ageGroups: { old: null, new: [{ minAge: 8, maxAge: 10 }], confidence: 0.95, excerpt: 'Ages 8 - 10' } },
        };
        expect(await resolveProposalSnapshot(proposal, store), `${name}:${record.id}`).toBe(true);
      }
    }
  });

  it('keeps a Forage capture with no contentType unreadable, as the 4.1.0 store did', async () => {
    const [record] = records.filter((item) => item.writer === 'forage.fetchSource');
    const parsed = parseSnapshotSourceRef(record!.snapshotRef)!;
    const supabase = stores.find(([name]) => name === 'supabase')![1];
    expect(await supabase.get(parsed.sourceId, parsed.bodyHash)).toBeUndefined();
  });
});
