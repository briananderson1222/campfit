import { createHash } from 'node:crypto';
import type { Snapshot } from '@kontourai/traverse/fetch';
import { describe, expect, it } from 'vitest';

import { isSnapshotIntact, snapshotIntegrityProblem } from '@/lib/ingestion/snapshot-integrity';

const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff]);
const binary: Snapshot = {
  sourceId: 'brochure', url: 'https://camp.example.test/brochure.pdf', fetchedAt: '2026-10-05T10:00:00.000Z',
  status: 200, contentType: 'pdf', body: '', bodyBytes: pdf,
  bodyHash: createHash('sha256').update(pdf).digest('hex'),
};

describe('snapshot integrity of a binary record', () => {
  it('accepts a binary record whose bytes hash to its bodyHash and that carries no text', () => {
    expect(isSnapshotIntact(binary)).toBe(true);
  });

  // Each still hashes to its bodyHash; only the binary-carries-text rule refuses it.
  it.each([
    ['a non-empty body', { body: 'readable text' }],
    ['text bytes', { bytes: pdf }],
    ['a declared charset', { declaredCharset: 'utf-8' }],
    ['a null declared charset', { declaredCharset: null }],
  ] as Array<[string, Partial<Snapshot>]>)('refuses a binary record that also carries %s', (_name, extra) => {
    expect(snapshotIntegrityProblem({ ...binary, ...extra })).toBe('a binary record also carries text');
  });
});
