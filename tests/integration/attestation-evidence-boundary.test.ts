import { beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshot, snapshotGet, connect, recordEvidenceOnLockedClient } = vi.hoisted(() => {
  const snapshot = {
    sourceId: 'campfit-discovery:https://example.com/programs',
    url: 'https://example.com/programs',
    fetchedAt: '2026-07-10T00:00:00.000Z',
    bodyHash: 'a'.repeat(64),
    body: 'Camp description: exact source excerpt.',
    status: 200,
    contentType: 'html' as const,
    headers: {},
  };
  return {
    snapshot,
    snapshotGet: vi.fn(async () => snapshot),
    connect: vi.fn(),
    recordEvidenceOnLockedClient: vi.fn(async (..._args: unknown[]) => undefined),
  };
});

vi.mock('@/lib/ingestion/traverse-snapshot-store', () => ({
  createCampfitSnapshotStore: () => ({ get: snapshotGet }),
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ connect }) }));
vi.mock('@/lib/admin/claim-store', () => ({
  acquireSubjectAdvisoryLock: vi.fn(async () => undefined),
  recordEvidenceOnLockedClient,
}));
vi.mock('@/lib/admin/verification-authority', () => ({
  refreshCampVerificationCache: vi.fn(async () => undefined),
}));

import { buildSnapshotSourceRef } from '@kontourai/traverse/fetch';
import {
  AttestationValidationError,
  recordCampAttestationEvidence,
} from '@/lib/admin/entity-admin-repository';

describe('exported attestation evidence boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    });
  });

  it('accepts an exact stored source citation and reaches the canonical write boundary', async () => {
    const excerpt = 'exact source excerpt';
    const start = snapshot.body.indexOf(excerpt);
    await recordCampAttestationEvidence({
      campId: 'camp-1',
      fields: ['description'],
      actor: 'reviewer@example.com',
      attestedAt: '2026-07-12T00:00:00.000Z',
      mode: 'source',
      sourceRef: buildSnapshotSourceRef(snapshot),
      sourceLocator: `chars:${start}-${start + excerpt.length}`,
      excerpt: `  ${excerpt}  `,
    });

    expect(snapshotGet).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(recordEvidenceOnLockedClient).toHaveBeenCalledOnce();
    const writeInput = recordEvidenceOnLockedClient.mock.calls[0]?.[2] as { evidence: unknown } | undefined;
    expect(writeInput?.evidence).toMatchObject({
      sourceRef: buildSnapshotSourceRef(snapshot),
      sourceLocator: `chars:${start}-${start + excerpt.length}`,
      excerptOrSummary: excerpt,
    });
  });

  it('rejects a mismatching source excerpt before persistence', async () => {
    await expect(
      recordCampAttestationEvidence({
        campId: 'camp-1',
        fields: ['description'],
        actor: 'reviewer@example.com',
        attestedAt: '2026-07-12T00:00:00.000Z',
        mode: 'source',
        sourceRef: buildSnapshotSourceRef(snapshot),
        sourceLocator: 'chars:0-8',
        excerpt: 'mismatch',
      }),
    ).rejects.toBeInstanceOf(AttestationValidationError);

    expect(connect).not.toHaveBeenCalled();
    expect(recordEvidenceOnLockedClient).not.toHaveBeenCalled();
  });

  it('rejects arbitrary fields and oversized values before persistence', async () => {
    await expect(
      recordCampAttestationEvidence({
        campId: 'camp-1', fields: ['invented'], actor: 'reviewer@example.com',
        attestedAt: '2026-07-12T00:00:00.000Z', mode: 'override', notes: 'reviewed',
      }),
    ).rejects.toBeInstanceOf(AttestationValidationError);
    await expect(
      recordCampAttestationEvidence({
        campId: 'camp-1', fields: ['organizationName'], actor: 'reviewer@example.com',
        attestedAt: '2026-07-12T00:00:00.000Z', mode: 'override', notes: 'reviewed',
      }),
    ).rejects.toBeInstanceOf(AttestationValidationError);
    await expect(
      recordCampAttestationEvidence({
        campId: 'camp-1', fields: ['description'], actor: 'reviewer@example.com',
        attestedAt: '2026-07-12T00:00:00.000Z', mode: 'override', notes: 'reviewed',
        values: { description: 'x'.repeat(100_001) },
      }),
    ).rejects.toBeInstanceOf(AttestationValidationError);
    expect(connect).not.toHaveBeenCalled();
  });
});
