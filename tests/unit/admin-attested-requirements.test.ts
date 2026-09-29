import type { ClaimGroupRollup, Evidence, RequirementRollup, VerificationEvent } from '@kontourai/surface';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ getPool: () => { throw new Error('no database in this unit test'); } }));

import { countAdminAttestedRequirements } from '@/lib/admin/verification-authority';

function requirement(id: string, claimIds: string[]): RequirementRollup {
  return {
    id, title: id, status: 'assumed', claimIds, required: true, severity: 'medium',
    verifiedClaims: [], staleClaims: [], disputedClaims: [], revokedClaims: [], unsupportedClaims: [...claimIds], missingClaimIds: [],
  };
}

function rollup(requirements: RequirementRollup[]): ClaimGroupRollup {
  return {
    id: 'verified-camp', title: 'Verified Camp Claim Set', kind: 'requirement-set', status: 'assumed',
    claimIds: requirements.flatMap((r) => r.claimIds), requirements,
    summary: {
      totalRequirements: requirements.length, requiredRequirements: requirements.length, verifiedRequirements: 0,
      staleRequirements: 0, disputedRequirements: 0, revokedRequirements: 0, unsupportedRequirements: requirements.length,
      missingClaims: 0, verificationCoverage: 0,
    },
  } as ClaimGroupRollup;
}

const evidence = (id: string, claimId: string, method: Evidence['method']): Evidence => ({
  id, claimId, evidenceType: method === 'attestation' ? 'attestation' : 'crawl_observation', method,
  sourceRef: 'fixture', excerptOrSummary: 'fixture', observedAt: '2026-09-01T00:00:00.000Z', collectedBy: 'fixture',
});
const event = (claimId: string, evidenceIds: string[], createdAt: string, method = 'attestation'): VerificationEvent => ({
  id: `${claimId}.${createdAt}`, claimId, status: 'assumed', type: 'verification', actor: 'fixture', method, evidenceIds, createdAt,
});

describe('admin-attested requirements under Surface 2.15+', () => {
  it('verifies a requirement only when every claim is governed by an attestation', () => {
    const bundle = {
      evidence: [
        evidence('e-attest-a', 'a', 'attestation'),
        evidence('e-attest-b', 'b', 'attestation'),
        evidence('e-crawl-c', 'c', 'extraction'),
        evidence('e-attest-d', 'd', 'attestation'),
        evidence('e-crawl-d', 'd', 'extraction'),
      ],
      events: [
        event('a', ['e-attest-a'], '2026-09-01T00:00:00.000Z'),
        // The /attest path's event method; the evidence is what counts.
        event('b', ['e-attest-b'], '2026-09-01T00:00:00.000Z', 'survey-assumption'),
        event('c', ['e-crawl-c'], '2026-09-01T00:00:00.000Z', 'extraction'),
        // Attested once, then superseded by an unreviewed crawl assumption.
        event('d', ['e-attest-d'], '2026-09-01T00:00:00.000Z'),
        event('d', ['e-crawl-d'], '2026-09-02T00:00:00.000Z', 'extraction'),
      ],
    };

    const derivation = {
      claims: ['a', 'b', 'c', 'd'].map((id) => ({ id, status: 'assumed' })),
      untimedOwnStatusByClaimId: { a: 'assumed', b: 'assumed', c: 'assumed', d: 'assumed' },
    };
    const allAttested = countAdminAttestedRequirements(rollup([requirement('r1', ['a']), requirement('r2', ['b'])]), bundle, derivation);
    expect(allAttested.status).toBe('verified');
    expect(allAttested.requirements.map((r) => r.status)).toEqual(['verified', 'verified']);
    expect(allAttested.summary).toMatchObject({ verifiedRequirements: 2, unsupportedRequirements: 0, verificationCoverage: 1 });

    const crawlOnly = countAdminAttestedRequirements(rollup([requirement('r1', ['a']), requirement('r3', ['c'])]), bundle, derivation);
    expect(crawlOnly.requirements.map((r) => r.status)).toEqual(['verified', 'assumed']);
    expect(crawlOnly.status).toBe('assumed');

    const superseded = countAdminAttestedRequirements(rollup([requirement('r4', ['d'])]), bundle, derivation);
    expect(superseded.status).toBe('assumed');
    expect(superseded.requirements[0]!.status).toBe('assumed');
  });

  it('counts a derived claim only when its own standing is sound and every input counts', () => {
    const bundle = {
      evidence: [evidence('e-attest-a', 'a', 'attestation'), evidence('e-crawl-c', 'c', 'extraction')],
      events: [event('a', ['e-attest-a'], '2026-09-01T00:00:00.000Z'), event('c', ['e-crawl-c'], '2026-09-01T00:00:00.000Z', 'extraction')],
    };
    const derivation = {
      claims: [
        { id: 'a', status: 'assumed' },
        { id: 'c', status: 'assumed' },
        { id: 'reviewed', status: 'verified' },
        // Own status verified, capped to assumed by an attested input: counts.
        { id: 'inherits-a', status: 'assumed', derivedFrom: ['a'] },
        { id: 'rollup-ok', status: 'assumed', derivedFrom: ['inherits-a', 'reviewed'] },
        // Resting on an unreviewed, unattested input: does not count.
        { id: 'inherits-c', status: 'assumed', derivedFrom: ['c'] },
        { id: 'rollup-bad', status: 'assumed', derivedFrom: ['inherits-a', 'inherits-c'] },
        // Own standing only assumed, no attestation: does not count.
        { id: 'own-assumed', status: 'assumed', derivedFrom: ['a'] },
        // A dangling input never counts.
        { id: 'dangling', status: 'assumed', derivedFrom: ['missing'] },
      ],
      untimedOwnStatusByClaimId: {
        a: 'assumed', c: 'assumed', reviewed: 'verified', 'inherits-a': 'verified', 'rollup-ok': 'verified',
        'inherits-c': 'verified', 'rollup-bad': 'verified', 'own-assumed': 'assumed', dangling: 'verified',
      },
    };
    const statuses = (ids: string[]) => countAdminAttestedRequirements(
      rollup(ids.map((id) => requirement(`r-${id}`, [id]))), bundle, derivation,
    ).requirements.map((r) => r.status);

    expect(statuses(['inherits-a', 'rollup-ok'])).toEqual(['verified', 'verified']);
    expect(statuses(['inherits-c', 'rollup-bad', 'own-assumed', 'dangling'])).toEqual(['assumed', 'assumed', 'assumed', 'assumed']);
  });
});
