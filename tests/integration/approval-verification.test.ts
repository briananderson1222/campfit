/**
 * What approving a crawl proposal does to the camp's derived verification
 * (`Camp.dataConfidence`), through the real review-apply path against a
 * throwaway Postgres. The stored snapshot is real; only its store is in memory.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSnapshotSourceRef, createInMemorySnapshotStore, sha256Hex, type SnapshotStore } from '@kontourai/traverse/fetch';
import { buildReviewSessionEvents, type ReviewQueueSessionState } from '@kontourai/survey/review-workbench';

const fixture = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/lib/ingestion/traverse-snapshot-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ingestion/traverse-snapshot-store')>()),
  createCampfitSnapshotStore: () => (fixture.store ??= createInMemorySnapshotStore()),
}));

import { getPool as getProductionPool } from '@/lib/db';
import { applyProposalReview } from '@/lib/admin/review-apply';
import { getProposal } from '@/lib/admin/review-repository';
import { bulkAttestCamp } from '@/lib/admin/bulk-attestation';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import type { FieldDiff, ProposedChanges } from '@/lib/admin/types';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const REVIEWER = 'reviewer@campfit.test';
const URL = 'https://aspengrove.example.test/camp';

/** The stored page. Every excerpt below is one of its lines, verbatim and unique. */
const PAGE = [
  'Aspen Grove is a week-long outdoor day camp for young naturalists.',
  'Camp type: summer day camp.',
  'Category: nature.',
  'Registration is open now.',
  'Located in Golden, Colorado.',
  'Website: https://aspengrove.example.test/',
  'Ages 6 - 10',
  'Tuition: $450 per week',
  'Session One: June 7 - June 11, 2027, 9:00 AM - 3:00 PM',
].join('\n');

function diff(old: unknown, next: unknown, excerpt: string): FieldDiff {
  return { old, new: next, confidence: 0.9, excerpt, sourceUrl: URL, mode: 'update' };
}

function session(times: boolean) {
  return {
    label: 'Session One', startDate: '2027-06-07', endDate: '2027-06-11',
    startTime: times ? '09:00' : null, endTime: times ? '15:00' : null, earlyDropOff: null, latePickup: null,
  };
}

/** One cited change for every Verified Camp requirement. */
function fullChanges(opts: { sessionTimes: boolean }): ProposedChanges {
  return {
    description: diff('', 'A week-long outdoor day camp for young naturalists.', 'Aspen Grove is a week-long outdoor day camp for young naturalists.'),
    campTypes: diff([], ['SUMMER_DAY'], 'Camp type: summer day camp.'),
    categories: diff([], ['NATURE'], 'Category: nature.'),
    registrationStatus: diff('UNKNOWN', 'OPEN', 'Registration is open now.'),
    city: diff('', 'Golden', 'Located in Golden, Colorado.'),
    websiteUrl: diff('', 'https://aspengrove.example.test/', 'Website: https://aspengrove.example.test/'),
    ageGroups: diff([], [{ label: 'Ages 6 - 10', minAge: 6, maxAge: 10, minGrade: null, maxGrade: null }], 'Ages 6 - 10'),
    pricing: diff([], [{ label: 'Tuition', amount: 450, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }], 'Tuition: $450 per week'),
    schedules: diff([], [session(opts.sessionTimes)], 'Session One: June 7 - June 11, 2027, 9:00 AM - 3:00 PM'),
  };
}

async function seedCamp(): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl")
     VALUES ($1, 'Aspen Grove', 'SLEEPAWAY', 'SPORTS', '', '', '') RETURNING id`,
    [`aspen-grove-${randomUUID()}`],
  );
  return rows[0]!.id;
}

/** A pending proposal. With `snapshot`, its excerpts cite a snapshot that is really in the store. */
async function seedProposal(campId: string, changes: ProposedChanges, opts: { snapshot: boolean }) {
  let snapshotRef: string | null = null;
  let bodyHash: string | null = null;
  if (opts.snapshot) {
    bodyHash = sha256Hex(PAGE);
    const snapshot = { sourceId: `camp-${campId}`, url: URL, fetchedAt: '2026-09-30T12:00:00.000Z', status: 200, contentType: 'text' as const, body: PAGE, bodyHash, headers: {} };
    fixture.store ??= createInMemorySnapshotStore();
    await (fixture.store as SnapshotStore).put(snapshot as never);
    snapshotRef = buildSnapshotSourceRef(snapshot as never);
  }
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status, "snapshotRef", "snapshotBodyHash")
     VALUES ($1, $2, $3::jsonb, 0.9, 'test-extraction-model', 'PENDING', $4, $5) RETURNING id`,
    [campId, URL, JSON.stringify(changes), snapshotRef, bodyHash],
  );
  return (await getProposal(rows[0]!.id))!;
}

/** Decide every item through the real Survey session, then apply. Fields not in `approve` keep their current value. */
async function review(proposalId: string, approve: readonly string[] | 'all') {
  const proposal = (await getProposal(proposalId))!;
  const reviewSession = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
  const decisionsByItemName = Object.fromEntries(reviewSession.snapshot.items.map((item) => [
    item.metadata.name,
    approve === 'all' || approve.includes(item.spec.target) ? ('accept-proposed' as const) : ('keep-current' as const),
  ]));
  const events = buildReviewSessionEvents({ ...(reviewSession.snapshot as ReviewQueueSessionState), decisionsByItemName });
  await replaceSurveyReviewEvents({ proposalId, reviewSessionId: reviewSession.id, proposal, events, actorEmail: REVIEWER });
  return applyProposalReview({ proposalId, reviewSessionId: reviewSession.id, reviewer: REVIEWER, keepPending: false });
}

async function dataConfidence(campId: string): Promise<string> {
  const { rows } = await getTestPool().query<{ dataConfidence: string }>(`SELECT "dataConfidence" FROM "Camp" WHERE id = $1`, [campId]);
  return rows[0]!.dataConfidence;
}

beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  fixture.store = null;
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "CrawlMetric";`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('approving a crawl proposal re-derives the camp from reviewed claims', () => {
  it('a camp whose every requirement was approved against a checked citation is VERIFIED', async () => {
    const campId = await seedCamp();
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
    const proposal = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.provenanceErrors).toEqual([]);
    expect([...applied.appliedFields].sort()).toEqual(
      ['ageGroups', 'campTypes', 'categories', 'city', 'description', 'pricing', 'registrationStatus', 'schedules', 'websiteUrl'],
    );
    expect(applied.verification).toEqual({ dataConfidence: 'VERIFIED', missingRequirements: [] });
    expect(await dataConfidence(campId)).toBe('VERIFIED');

    // The reviewer's decision is its own evidence, beside the crawl observation.
    const { rows } = await getTestPool().query<{ evidenceType: string; collectedBy: string }>(
      `SELECT "evidenceType", "collectedBy" FROM "SurfaceEvidence" WHERE "claimId" = $1 ORDER BY "evidenceType"::text`,
      [`camp.${campId}.field.city`],
    );
    expect(rows).toEqual([
      { evidenceType: 'crawl_observation', collectedBy: 'test-extraction-model' },
      { evidenceType: 'human_attestation', collectedBy: REVIEWER },
    ]);
  });

  it('a camp with requirements nobody reviewed is not VERIFIED, and they are listed', async () => {
    const campId = await seedCamp();
    const proposal = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });

    const applied = await review(proposal.id, ['description', 'city', 'ageGroups']);

    expect([...applied.appliedFields].sort()).toEqual(['ageGroups', 'city', 'description']);
    expect(applied.verification?.dataConfidence).toBe('PLACEHOLDER');
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(
      ['campType', 'category', 'registrationStatus', 'websiteUrl', 'pricing'],
    );
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.title)).toEqual(
      ['Camp type', 'Category', 'Registration status', 'Website URL', 'Pricing'],
    );
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
  });

  it('an approval with no checked citation does not count as reviewed', async () => {
    const campId = await seedCamp();
    // Same changes and excerpts, but no stored snapshot to check them against.
    const proposal = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: false });

    const applied = await review(proposal.id, 'all');

    expect(applied.appliedFields).toHaveLength(9);
    expect(applied.verification?.dataConfidence).toBe('PLACEHOLDER');
    expect(applied.verification?.missingRequirements.map((requirement) => [requirement.id, requirement.status])).toEqual([
      ['description', 'proposed'], ['campType', 'proposed'], ['category', 'proposed'], ['registrationStatus', 'proposed'],
      ['city', 'proposed'], ['websiteUrl', 'proposed'], ['ageGroups', 'proposed'], ['pricing', 'proposed'],
      ['sessions-verified', 'proposed'],
    ]);
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
  });

  it('approving one field on a VERIFIED camp leaves it VERIFIED', async () => {
    const campId = await seedCamp();
    expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
    const proposal = await seedProposal(
      campId,
      { description: fullChanges({ sessionTimes: true }).description! },
      { snapshot: true },
    );

    const applied = await review(proposal.id, 'all');

    expect(applied.appliedFields).toEqual(['description']);
    expect(applied.verification).toEqual({ dataConfidence: 'VERIFIED', missingRequirements: [] });
    expect(await dataConfidence(campId)).toBe('VERIFIED');
  });

  it('a session with no stated time keeps the sessions requirement open', async () => {
    const campId = await seedCamp();
    const proposal = await seedProposal(campId, fullChanges({ sessionTimes: false }), { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.verification?.dataConfidence).toBe('PLACEHOLDER');
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['sessions-verified']);
    // The session's dates were reviewed; its time was not stated, so it has no claim.
    const { rows } = await getTestPool().query<{ fieldOrBehavior: string }>(
      `SELECT "fieldOrBehavior" FROM "SurfaceClaimDefinition" WHERE "subjectType" = 'public-directory.camp-session' ORDER BY 1`,
    );
    expect(rows.map((row) => row.fieldOrBehavior)).toEqual(['dates']);
  });
});
