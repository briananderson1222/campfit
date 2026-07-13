import { createHash } from 'node:crypto';
import { buildSnapshotSourceRef, createInMemorySnapshotStore, type Snapshot, type SnapshotStore } from '@kontourai/traverse/fetch';
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
