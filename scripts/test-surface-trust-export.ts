import assert from 'node:assert/strict';
import { buildCampfitSurfaceTrustInput } from '../lib/surface-trust-export';
import type { Camp } from '../lib/types';
import type { CampChangeProposal } from '../lib/admin/types';

const generatedAt = '2026-06-02T00:00:00.000Z';

const camp = {
  id: 'camp-demo',
  slug: 'demo-camp',
  name: 'Demo Camp',
  websiteUrl: 'https://example.org/camps/demo',
  registrationStatus: 'OPEN',
  dataConfidence: 'VERIFIED',
  lastVerifiedAt: '2026-05-31T00:00:00.000Z',
  lastCrawledAt: '2026-05-30T00:00:00.000Z',
  fieldSources: {
    registrationStatus: {
      sourceUrl: 'https://example.org/camps/demo',
      excerpt: 'Registration is open for summer sessions.',
      approvedAt: '2026-05-31T00:00:00.000Z',
    },
  },
} satisfies Pick<Camp, 'id' | 'slug' | 'name' | 'websiteUrl' | 'registrationStatus' | 'dataConfidence' | 'lastVerifiedAt' | 'lastCrawledAt' | 'fieldSources'>;

const pendingProposal = {
  id: 'proposal-demo',
  campId: camp.id,
  crawlRunId: 'run-demo',
  createdAt: '2026-05-30T00:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  status: 'PENDING',
  sourceUrl: 'https://example.org/camps/demo',
  rawExtraction: {},
  proposedChanges: {
    registrationStatus: {
      old: 'UNKNOWN',
      new: 'OPEN',
      confidence: 0.88,
      excerpt: 'Registration is open for summer sessions.',
      sourceUrl: 'https://example.org/camps/demo',
      mode: 'update',
    },
  },
  overallConfidence: 0.88,
  extractionModel: 'campfit-crawl-demo',
  reviewerNotes: null,
  feedbackTags: null,
  priority: 0,
  appliedFields: [],
} satisfies CampChangeProposal;

const proof = buildCampfitSurfaceTrustInput({ camp, proposal: pendingProposal, generatedAt });

assert.equal(proof.schemaVersion, 3);
assert.equal(proof.source, 'campfit.surface-adapter.registration-status-proof');
assert.equal(proof.claims.length, 2);

const current = proof.claims.find((claim) => claim.claimType === 'public-data.field');
assert.equal(current?.fieldOrBehavior, 'registrationStatus');
assert.equal(current?.value, 'OPEN');
assert.equal(current?.status, 'verified');
assert.equal(current?.metadata?.survey && typeof current.metadata.survey === 'object', true);

const proposed = proof.claims.find((claim) => claim.claimType === 'public-data.field-candidate');
assert.equal(proposed?.value, 'OPEN');
assert.equal(proposed?.status, 'proposed');
assert.equal(proposed?.confidenceBasis?.extractionConfidence, 0.88);

assert.ok(proof.evidence.some((item) => item.evidenceType === 'crawl_observation' && item.sourceRef === 'https://example.org/camps/demo'));
assert.ok(proof.events.some((event) => event.method === 'field-source-approval'));
assert.ok(proof.events.some((event) => event.method === 'crawl-proposal'));

console.log(JSON.stringify({
  claims: proof.claims.length,
  evidence: proof.evidence.length,
  events: proof.events.length,
  statuses: proof.claims.map((claim) => claim.status),
}, null, 2));
