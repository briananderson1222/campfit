import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSnapshotSourceRef,
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
  fetchSource,
  type Snapshot,
  type SnapshotStore,
} from '@kontourai/traverse/fetch';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG,
  LOW_RISK_FIELDS,
  evaluateShadowAutoAccept,
} from '@/lib/admin/shadow-auto-accept';
import { isProposalSnapshotResolved, resolveProposalSnapshot, resolveProposalSnapshots } from '@/lib/admin/shadow-auto-accept-read';
import type { ProposedChanges } from '@/lib/admin/types';

function changes(field = 'description'): ProposedChanges {
  return { [field]: { old: 'old', new: 'new', confidence: 0.95, excerpt: 'new' } };
}

describe('evaluateShadowAutoAccept', () => {
  it('keeps the default low-risk policy to the six reviewed fields', () => {
    expect(LOW_RISK_FIELDS).toEqual([
      'organizationName', 'description', 'campType', 'category', 'ageGroups', 'city',
    ]);
    expect(evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes('name'),
      snapshotResolved: true,
    }).perField[0]).toMatchObject({ class: 'high-risk', pass: false });
  });

  it('passes a high-confidence, low-risk proposal with exact snapshot evidence', () => {
    const result = evaluateShadowAutoAccept({
      overallConfidence: 0.95,
      proposedChanges: changes(),
      snapshotResolved: true,
    });
    expect(result.wouldAutoAccept).toBe(true);
    expect(result.perField).toEqual([expect.objectContaining({ field: 'description', class: 'low-risk', pass: true })]);
    expect(result.config.threshold).toBe(DEFAULT_SHADOW_AUTO_ACCEPT_CONFIG.threshold);
  });

  it('fails when confidence alone is below threshold', () => {
    expect(evaluateShadowAutoAccept({
      overallConfidence: 0.89,
      proposedChanges: changes(),
      snapshotResolved: true,
    }).wouldAutoAccept).toBe(false);
  });

  it('fails when snapshot resolution alone is absent', () => {
    expect(evaluateShadowAutoAccept({
      overallConfidence: 0.95,
      proposedChanges: changes(),
      snapshotResolved: false,
    }).wouldAutoAccept).toBe(false);
  });

  it('fails closed for null confidence', () => {
    expect(evaluateShadowAutoAccept({
      overallConfidence: null,
      proposedChanges: changes(),
      snapshotResolved: true,
    }).wouldAutoAccept).toBe(false);
  });

  it('lets one high-risk money field poison an otherwise passing proposal', () => {
    const result = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: { ...changes(), ...changes('pricing') },
      snapshotResolved: true,
    });
    expect(result.wouldAutoAccept).toBe(false);
    expect(result.perField.find((field) => field.field === 'pricing')).toMatchObject({ class: 'high-risk', pass: false });
  });

  it('fails closed for an unknown field and for an empty proposal', () => {
    expect(evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes('futureField'),
      snapshotResolved: true,
    }).perField[0]).toMatchObject({ class: 'high-risk', pass: false });
    expect(evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: {},
      snapshotResolved: true,
    }).wouldAutoAccept).toBe(false);
  });

  it('supports an explicit threshold override', () => {
    expect(evaluateShadowAutoAccept({
      overallConfidence: 0.8,
      proposedChanges: changes(),
      snapshotResolved: true,
    }, { threshold: 0.8 }).wouldAutoAccept).toBe(true);
  });

  it('allows only narrowing the default low-risk allowlist', () => {
    const narrowed = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes('description'),
      snapshotResolved: true,
    }, { lowRiskFields: ['organizationName'] });
    expect(narrowed.config.valid).toBe(true);
    expect(narrowed.wouldAutoAccept).toBe(false);

    const widening = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes('name'),
      snapshotResolved: true,
    }, { lowRiskFields: ['description', 'name'] });
    expect(widening.config.valid).toBe(false);
    expect(widening.wouldAutoAccept).toBe(false);
  });

  it('lets high-risk overrides add denials and gives high-risk precedence', () => {
    const result = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes('description'),
      snapshotResolved: true,
    }, { highRiskFields: ['description'] });
    expect(result.config.valid).toBe(true);
    expect(result.perField[0]).toMatchObject({ class: 'high-risk', pass: false });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])('fails for invalid threshold %s', (threshold) => {
    const result = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes(),
      snapshotResolved: true,
    }, { threshold });
    expect(result.config.valid).toBe(false);
    expect(result.wouldAutoAccept).toBe(false);
  });

  it('fails for malformed runtime field-list overrides', () => {
    const result = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes(),
      snapshotResolved: true,
    }, { lowRiskFields: 'description' as unknown as string[] });
    expect(result.config.valid).toBe(false);
    expect(result.wouldAutoAccept).toBe(false);
  });

  it('fails for an explicitly null runtime threshold', () => {
    const result = evaluateShadowAutoAccept({
      overallConfidence: 0.99,
      proposedChanges: changes(),
      snapshotResolved: true,
    }, { threshold: null as unknown as number });
    expect(result.config.valid).toBe(false);
    expect(result.wouldAutoAccept).toBe(false);
  });
});

describe('isProposalSnapshotResolved', () => {
  it('requires every field excerpt to resolve uniquely against the snapshot', () => {
    expect(isProposalSnapshotResolved({ proposedChanges: changes() }, 'before new after')).toBe(true);
    expect(isProposalSnapshotResolved({ proposedChanges: changes() }, 'new and new')).toBe(false);
    expect(isProposalSnapshotResolved({ proposedChanges: changes() }, undefined)).toBe(false);
  });

  it('requires proposal/ref/store identity and a hash of the actual bytes', async () => {
    const sourceUrl = 'https://shadow.example.test/camp';
    const body = 'before new after';
    const snapshot: Snapshot = {
      sourceId: 'shadow-source', url: sourceUrl, fetchedAt: '2026-07-13T12:00:00.000Z',
      status: 200, contentType: 'html', body,
      bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    };
    const store = createInMemorySnapshotStore();
    await store.put(snapshot);
    const proposal = {
      sourceUrl: 'https://original.example.test/redirect',
      snapshotRef: buildSnapshotSourceRef(snapshot),
      snapshotBodyHash: snapshot.bodyHash,
      proposedChanges: changes(),
    };
    // CampChangeProposal.sourceUrl may be the original request URL while the
    // immutable snapshot ref records the final URL after redirects. The ref
    // and stored snapshot are canonical for byte identity.
    expect(proposal.sourceUrl).not.toBe(snapshot.url);
    expect(await resolveProposalSnapshot(proposal, store)).toBe(true);
    expect(await resolveProposalSnapshot({ ...proposal, snapshotRef: 'not a snapshot ref' }, store)).toBe(false);

    const corrupted: Snapshot = { ...snapshot, body: 'tampered bytes' };
    const corruptedStore: SnapshotStore = {
      put: async () => undefined,
      latest: async () => corrupted,
      list: async () => [corrupted],
      get: async () => corrupted,
    };
    expect(await resolveProposalSnapshot(proposal, corruptedStore)).toBe(false);

    const wrongSource: Snapshot = { ...snapshot, sourceId: 'other-source' };
    const wrongSourceStore: SnapshotStore = { ...corruptedStore, get: async () => wrongSource };
    expect(await resolveProposalSnapshot(proposal, wrongSourceStore)).toBe(false);
  });

  it('caches identical snapshot reads in the bounded bulk resolver', async () => {
    const sourceUrl = 'https://shadow.example.test/cached';
    const body = 'new';
    const snapshot: Snapshot = {
      sourceId: 'cached-source', url: sourceUrl, fetchedAt: '2026-07-13T12:00:00.000Z',
      status: 200, contentType: 'html', body,
      bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    };
    let getCalls = 0;
    const store: SnapshotStore = {
      put: async () => undefined,
      latest: async () => snapshot,
      list: async () => [snapshot],
      get: async () => { getCalls += 1; return snapshot; },
    };
    const proposal = {
      snapshotRef: buildSnapshotSourceRef(snapshot),
      snapshotBodyHash: snapshot.bodyHash,
      proposedChanges: changes(),
    };
    expect(await resolveProposalSnapshots([proposal, proposal, proposal], { concurrency: 2, store })).toEqual([true, true, true]);
    expect(getCalls).toBe(1);
  });
});

/**
 * Traverse 5 hashes a text capture by its response bytes. A page that is not
 * plain UTF-8 has a bodyHash that is NOT the hash of the UTF-8 of its decoded
 * body; the shadow read must rehash on the bytes basis or it rejects every
 * such capture.
 */
describe('resolveProposalSnapshot for captures hashed by their bytes', () => {
  async function capture(id: string, bytes: Uint8Array, contentType: string): Promise<Snapshot> {
    const result = await fetchSource(
      { id, url: `https://bytes.example.test/${id}`, respectRobots: false, retries: 0 },
      {
        clock: () => '2026-10-05T10:00:00.000Z',
        sleep: async () => {},
        fetch: async () => new Response(bytes.slice(), { status: 200, headers: { 'content-type': contentType } }),
      },
    );
    if (!result.snapshot) throw new Error(`fetch failed: ${JSON.stringify(result.error)}`);
    return result.snapshot;
  }
  const page = 'Summer at Café Camp: new';
  const latin1 = Uint8Array.from([...page].map((ch) => ch.codePointAt(0)!));
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(page)]);
  // [id, bytes, Content-Type, the text Traverse decodes]. The last two declare no
  // charset (declaredCharset null), which is still the bytes basis.
  const cases: Array<[string, Uint8Array, string, string]> = [
    ['latin1', latin1, 'text/html; charset=iso-8859-1', page],
    ['utf8-bom', bom, 'text/html; charset=utf-8', page],
    ['bom-no-charset', bom, 'text/html', page],
    ['invalid-utf8-no-charset', latin1, 'text/html', page.replace('é', '\uFFFD')],
  ];

  it.each(cases)('resolves a %s capture read back from the filesystem and in-memory stores', async (id, bytes, contentType, text) => {
    const snapshot = await capture(id, bytes, contentType);
    expect(snapshot.body).toBe(text);
    expect(snapshot.declaredCharset).toBe(contentType.includes('charset=') ? contentType.split('charset=')[1] : null);
    expect(snapshot.bodyHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(snapshot.bodyHash).not.toBe(createHash('sha256').update(snapshot.body, 'utf8').digest('hex'));
    const proposal = { snapshotRef: buildSnapshotSourceRef(snapshot), snapshotBodyHash: snapshot.bodyHash, proposedChanges: changes() };

    const root = await mkdtemp(path.join(os.tmpdir(), 'campfit-shadow-bytes-'));
    try {
      for (const store of [createInMemorySnapshotStore(), createFilesystemSnapshotStore({ root })]) {
        await store.put(snapshot);
        expect(await resolveProposalSnapshot(proposal, store)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(cases)('refuses a %s capture whose body is not the decode of its bytes', async (id, bytes, contentType) => {
    const snapshot = await capture(id, bytes, contentType);
    const proposal = { snapshotRef: buildSnapshotSourceRef(snapshot), snapshotBodyHash: snapshot.bodyHash, proposedChanges: changes() };
    const rewritten: Snapshot = { ...snapshot, body: 'Summer at another camp: new' };
    const store: SnapshotStore = { put: async () => undefined, latest: async () => rewritten, list: async () => [rewritten], get: async () => rewritten };
    expect(await resolveProposalSnapshot(proposal, store)).toBe(false);
  });
});
