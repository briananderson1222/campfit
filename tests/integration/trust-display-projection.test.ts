import { describe, expect, it } from 'vitest';
import type { TrustBundle } from '@kontourai/surface';
import { projectTrustDisplay } from '@/lib/admin/trust-display';
import { buildCampAttestationTrustInput, buildCampReviewTrustInput } from '@/lib/admin/trust-projection';
import { validateCampAttestationEvidenceInput } from '@/lib/admin/entity-admin-repository';
import { approvedFieldsRequireSnapshot, canBuildReviewTrustBundle } from '@/lib/admin/review-apply';

const at = '2026-01-01T00:00:00Z';
function human(mode: 'source' | 'override' = 'source'): TrustBundle {
  return buildCampAttestationTrustInput({ campId: 'camp', fields: ['name'], actor: 'human', attestedAt: at, mode, notes: mode === 'override' ? 'called provider' : undefined, sourceRef: mode === 'source' ? 'snapshot:1' : undefined, sourceLocator: mode === 'source' ? 'chars:2-6' : undefined, excerpt: mode === 'source' ? 'camp' : undefined });
}
function crawl(): TrustBundle {
  return buildCampReviewTrustInput({ proposalId: 'p', campId: 'camp', sourceUrl: 'https://example.test', snapshotRef: 'snapshot:1', snapshotBody: 'a camp here', proposedChanges: { name: { old: 'old', new: 'camp', confidence: 1, excerpt: 'camp' } }, approvedFields: ['name'], reviewer: 'reviewer', reviewedAt: at });
}

describe('trust display projection', () => {
  it('projects actual crawl and human citation contracts with evidence parity', () => {
    const crawlBundle = crawl(); const humanBundle = human();
    expect(projectTrustDisplay(crawlBundle, { 'snapshot:1': 'a camp here' }, crawlBundle.evidence.find(e => e.excerptOrSummary === 'camp')!.claimId, new Date(at))).toMatchObject({ evidenceState: 'verified_current', trustOrigin: 'crawl' });
    expect(projectTrustDisplay(humanBundle, { 'snapshot:1': 'a camp here' }, humanBundle.claims[0].id, new Date(at))).toMatchObject({ evidenceState: 'verified_current', trustOrigin: 'human' });
    const crawlCitation = crawlBundle.evidence.find(e => e.excerptOrSummary === 'camp')!;
    const humanCitation = humanBundle.evidence[0];
    for (const key of ['sourceRef', 'sourceLocator', 'excerptOrSummary', 'observedAt'] as const) expect(typeof humanCitation[key]).toBe(typeof crawlCitation[key]);
    expect(humanCitation.method).toBe('attestation'); expect(crawlCitation.method).toBe('extraction');
    expect(crawlCitation).toMatchObject({ sourceRef: 'snapshot:1', sourceLocator: 'chars:2-6', excerptOrSummary: 'camp' });
  });

  it('refuses to author approved crawl Evidence without immutable resolvable snapshot inputs', () => {
    const legacy = buildCampReviewTrustInput({ proposalId: 'p', campId: 'camp', sourceUrl: 'https://example.test', proposedChanges: { name: { old: 'old', new: 'camp', confidence: 1, excerpt: 'camp' } }, approvedFields: ['name'], reviewer: 'reviewer', reviewedAt: at });
    expect(legacy.evidence[0].excerptOrSummary).not.toBe('camp');
  });

  it('degrades mismatch and distinguishes override without source', () => {
    const source = human(); expect(projectTrustDisplay(source, { 'snapshot:1': 'changed' }, source.claims[0].id, new Date(at)).evidenceState).toBe('stale_unresolvable');
    const override = human('override'); expect(projectTrustDisplay(override, {}, override.claims[0].id, new Date(at))).toMatchObject({ evidenceState: 'attested_no_source', trustOrigin: 'human' });
  });

  it.each(['assumed', 'disputed', 'revoked', 'rejected', 'superseded'] as const)('does not promote %s source events', (status) => {
    const bundle = human(); bundle.events[0].status = status; bundle.claims[0].status = status;
    expect(projectTrustDisplay(bundle, { 'snapshot:1': 'a camp here' }, bundle.claims[0].id, new Date(at)).evidenceState).toBe('unverified');
  });

  it('authors human source Evidence in canonical attestation citation shape', () => {
    const result = human();
    expect(result.evidence[0]).toMatchObject({ method: 'attestation', sourceRef: 'snapshot:1', sourceLocator: 'chars:2-6', excerptOrSummary: 'camp', metadata: { mode: 'source' } });
    expect(result.events[0].status).toBe('verified');
  });

  it('fails closed before writing incomplete source attestations', () => {
    for (const input of [
      { mode: 'source' as const, sourceLocator: 'chars:0-4', excerpt: 'camp' },
      { mode: 'source' as const, sourceRef: 'snapshot:1', excerpt: 'camp' },
      { mode: 'source' as const, sourceRef: 'snapshot:1', sourceLocator: 'field:name', excerpt: 'camp' },
      { mode: 'source' as const, sourceRef: 'snapshot:1', sourceLocator: 'chars:0-4', excerpt: ' ' },
    ]) expect(() => validateCampAttestationEvidenceInput(input)).toThrow(/complete snapshot citation/);
    expect(() => validateCampAttestationEvidenceInput({ mode: 'source', sourceRef: 'snapshot:1', sourceLocator: 'chars:0-4', excerpt: 'camp' })).not.toThrow();
    expect(() => validateCampAttestationEvidenceInput({ mode: 'source', sourceRef: 'x'.repeat(4097), sourceLocator: 'chars:0-4', excerpt: 'camp' })).toThrow(/sourceRef is too large/);
    expect(() => validateCampAttestationEvidenceInput({ mode: 'override', notes: 'x'.repeat(10_001) })).toThrow(/reason is too large/);
  });

  it('requires proposal snapshot loading only for approved excerpt-bearing diffs', () => {
    expect(approvedFieldsRequireSnapshot({ schedules: { old: [{ label: 'A' }], new: [], confidence: 1 } }, ['schedules'])).toBe(false);
    expect(approvedFieldsRequireSnapshot({ description: { old: 'old', new: 'new', excerpt: 'new', confidence: 1 } }, ['description'])).toBe(true);
    expect(approvedFieldsRequireSnapshot({ description: { old: 'old', new: 'new', excerpt: 'new', confidence: 1 } }, [])).toBe(false);
    const excerptChange = { description: { old: 'old', new: 'new', excerpt: 'new', confidence: 1 } };
    expect(canBuildReviewTrustBundle({}, excerptChange, ['description'])).toBe(true);
    expect(canBuildReviewTrustBundle({ snapshotRef: 'snapshot:1', snapshotBody: 'new' }, excerptChange, ['description'])).toBe(true);
    expect(canBuildReviewTrustBundle({}, { schedules: { old: [], new: [], confidence: 1 } }, ['schedules'])).toBe(true);
    expect(canBuildReviewTrustBundle({ snapshotRef: 'snapshot:1', snapshotBody: 'body' }, { schedules: { old: [], new: [], confidence: 1 } }, ['schedules'])).toBe(true);
  });
});
