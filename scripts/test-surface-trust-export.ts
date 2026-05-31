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
  schedules: [
    {
      id: 'schedule-demo-week-1',
      label: 'Week 1',
      startDate: '2026-06-08',
      endDate: '2026-06-12',
      startTime: '09:00',
      endTime: '15:00',
      earlyDropOff: '08:00',
      latePickup: null,
    },
  ],
  fieldSources: {
    registrationStatus: {
      sourceUrl: 'https://example.org/camps/demo',
      excerpt: 'Registration is open for summer sessions.',
      approvedAt: '2026-05-31T00:00:00.000Z',
    },
    schedules: {
      sourceUrl: 'https://example.org/camps/demo/schedule',
      excerpt: 'Week 1 runs June 8-12 from 9:00 AM to 3:00 PM.',
      approvedAt: '2026-05-31T00:00:00.000Z',
    },
  },
} satisfies Pick<Camp, 'id' | 'slug' | 'name' | 'websiteUrl' | 'registrationStatus' | 'dataConfidence' | 'lastVerifiedAt' | 'lastCrawledAt' | 'fieldSources' | 'schedules'>;

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
    schedules: {
      old: camp.schedules,
      new: [
        ...camp.schedules,
        {
          label: 'Week 2',
          startDate: '2026-06-15',
          endDate: '2026-06-19',
          startTime: '09:00',
          endTime: '15:00',
          earlyDropOff: '08:00',
          latePickup: null,
        },
      ],
      confidence: 0.82,
      excerpt: 'Week 2 runs June 15-19 from 9:00 AM to 3:00 PM.',
      sourceUrl: 'https://example.org/camps/demo/schedule',
      mode: 'add_items',
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
const emptyScheduleProof = buildCampfitSurfaceTrustInput({
  camp: {
    ...camp,
    id: 'camp-empty-schedule-demo',
    schedules: [],
    fieldSources: {
      schedules: {
        sourceUrl: 'https://example.org/camps/empty/schedule',
        excerpt: null,
        approvedAt: '2026-05-31T00:00:00.000Z',
      },
    },
  },
  generatedAt,
});

assert.equal(proof.schemaVersion, 3);
assert.equal(proof.source, 'campfit.surface-adapter.public-directory-proof');
assert.equal(proof.claims.length, 4);

const current = proof.claims.find((claim) => claim.claimType === 'public-data.field');
assert.equal(current?.fieldOrBehavior, 'registrationStatus');
assert.equal(current?.value, 'OPEN');
assert.equal(current?.status, 'verified');
assert.equal(current?.metadata?.survey && typeof current.metadata.survey === 'object', true);

const proposed = proof.claims.find((claim) => claim.claimType === 'public-data.field-candidate');
assert.equal(proposed?.value, 'OPEN');
assert.equal(proposed?.status, 'proposed');
assert.equal(proposed?.confidenceBasis?.extractionConfidence, 0.88);

const currentSchedules = proof.claims.find((claim) => claim.claimType === 'public-data.repeated-field');
assert.equal(currentSchedules?.fieldOrBehavior, 'schedules');
assert.equal(currentSchedules?.status, 'verified');
assert.equal(Array.isArray(currentSchedules?.value), true);
assert.equal((currentSchedules?.value as unknown[]).length, 1);

const proposedSchedules = proof.claims.find((claim) => claim.claimType === 'public-data.repeated-field-candidate');
assert.equal(proposedSchedules?.fieldOrBehavior, 'schedules');
assert.equal(proposedSchedules?.status, 'proposed');
assert.equal(proposedSchedules?.confidenceBasis?.extractionConfidence, 0.82);
assert.equal(
  (proposedSchedules?.metadata?.survey as { repeated?: { itemCount?: number } } | undefined)?.repeated?.itemCount,
  2,
);
assert.equal(
  (proposedSchedules?.metadata?.survey as { repeated?: { representation?: string } } | undefined)?.repeated?.representation,
  'aggregate-array',
);
assert.equal((proposedSchedules?.metadata?.campfit as { proposalId?: string } | undefined)?.proposalId, pendingProposal.id);

assert.ok(proof.evidence.some((item) => item.evidenceType === 'crawl_observation' && item.sourceRef === 'https://example.org/camps/demo'));
assert.ok(proof.evidence.some((item) => item.evidenceType === 'crawl_observation' && item.sourceRef === 'https://example.org/camps/demo/schedule'));
assert.ok(proof.events.some((event) => event.method === 'field-source-approval'));
assert.ok(proof.events.some((event) => event.method === 'crawl-proposal'));

const emptySchedules = emptyScheduleProof.claims.find((claim) => claim.fieldOrBehavior === 'schedules');
assert.equal(emptySchedules?.claimType, 'public-data.repeated-field');
assert.equal(emptySchedules?.status, 'verified');
assert.deepEqual(emptySchedules?.value, []);

console.log(JSON.stringify({
  claims: proof.claims.length,
  evidence: proof.evidence.length,
  events: proof.events.length,
  statuses: proof.claims.map((claim) => claim.status),
}, null, 2));
