/**
 * What approving a crawl proposal does to the camp's derived verification
 * (`Camp.dataConfidence`), through the real review-apply path against a
 * throwaway Postgres. The stored snapshot is real; only its store is in memory.
 */
import { createHash, randomUUID } from 'node:crypto';
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
import { acquireSubjectAdvisoryLock, appendEvent, appendEvidence, claimStoreTestHooks, persistClaim } from '@/lib/admin/claim-store';
import { CampLockNotHeldError, deriveCampVerification, refreshCampVerificationCache, refreshCampVerificationCacheOnLockedClient, verificationCacheTestHooks } from '@/lib/admin/verification-authority';
import { projectTrustStatusToDataConfidence } from '@/lib/admin/verification-policy';
import { createProposal } from '@/lib/admin/review-repository';
import { replaceAdminCampAgeGroups, updateAdminCampFields } from '@/lib/admin/camp-repository';
import { recordCampAttestationEvidence, updateAssistantCampFields } from '@/lib/admin/entity-admin-repository';
import { applyBatchAcceptedClaims, isTransientDatabaseError, ReviewApplyBusyError, ReviewApplyEvidenceError, ReviewApplyValueError } from '@/lib/admin/review-apply';
import { loadCampTrustDisplays } from '@/lib/admin/trust-display-read';
import { getCampProposalHistoryBatch } from '@/lib/admin/review-repository';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import type { FieldDiff, ProposedChanges } from '@/lib/admin/types';
import { recordStewardEntry } from '@/lib/admin/steward-entry';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const REVIEWER = 'reviewer@campfit.test';
const SESSION_ONE = 'Session One: June 7 - June 11, 2027, 9:00 AM - 3:00 PM';
const SESSION_TWO = 'Session Two: June 14 - June 18, 2027, 9:00 AM - 3:00 PM';
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
  'Session Two: June 14 - June 18, 2027, 9:00 AM - 3:00 PM',
].join('\n');

function diff(old: unknown, next: unknown, excerpt: string): FieldDiff {
  return { old, new: next, confidence: 0.9, excerpt, sourceUrl: URL, mode: 'update' };
}

/**
 * A list change whose every row cites its own line of the page. A session row
 * that states a time cites that same line for it (each session line states
 * its dates and its time), as a crawl records it (`RowCitation.times`).
 */
function listDiff(old: unknown, rows: unknown[], excerpts: string[]): FieldDiff {
  return {
    ...diff(old, rows, excerpts[0]!),
    rowCitations: excerpts.map((excerpt, i) => {
      const row = rows[i] as { startTime?: unknown; endTime?: unknown } | undefined;
      return row?.startTime && row?.endTime ? { excerpt, times: [{ excerpt }] } : { excerpt };
    }),
  };
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
    campTypes: listDiff([], ['SUMMER_DAY'], ['Camp type: summer day camp.']),
    categories: listDiff([], ['NATURE'], ['Category: nature.']),
    registrationStatus: diff('UNKNOWN', 'OPEN', 'Registration is open now.'),
    city: diff('', 'Golden', 'Located in Golden, Colorado.'),
    websiteUrl: diff('', 'https://aspengrove.example.test/', 'Website: https://aspengrove.example.test/'),
    ageGroups: listDiff([], [{ label: 'Ages 6 - 10', minAge: 6, maxAge: 10, minGrade: null, maxGrade: null }], ['Ages 6 - 10']),
    pricing: listDiff([], [{ label: 'Tuition', amount: 450, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }], ['Tuition: $450 per week']),
    schedules: listDiff([], [session(opts.sessionTimes)], [SESSION_ONE]),
  };
}

/**
 * A camp Mark Verified can verify: it lists an age group and a price (an
 * empty required list is a gap Mark Verified does not attest), and its empty
 * session list is attested as intentionally empty by a steward.
 */
async function seedCamp(): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl")
     VALUES ($1, 'Aspen Grove', 'SLEEPAWAY', 'SPORTS', '', '', '') RETURNING id`,
    [`aspen-grove-${randomUUID()}`],
  );
  const campId = rows[0]!.id;
  await getTestPool().query(`INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge") VALUES (gen_random_uuid()::text, $1, 'Ages 6 - 10', 6, 10)`, [campId]);
  await getTestPool().query(`INSERT INTO "CampPricing" (id, "campId", label, amount, unit) VALUES (gen_random_uuid()::text, $1, 'Tuition', 450, 'PER_WEEK')`, [campId]);
  await recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'schedules', reason: 'fixture: sessions are listed later' }, 'steward@campfit.test');
  return campId;
}

/** A pending proposal. With `snapshot`, its excerpts cite a snapshot that is really in the store. */
async function seedProposal(campId: string, changes: ProposedChanges, opts: { snapshot: boolean; contentFingerprint?: string; incomplete?: boolean; crawlRunId?: string }) {
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
    `INSERT INTO "CampChangeProposal" ("campId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status, "snapshotRef", "snapshotBodyHash", "rawExtraction", "crawlRunId")
     VALUES ($1, $2, $3::jsonb, 0.9, 'test-extraction-model', 'PENDING', $4, $5, $6::jsonb, $7) RETURNING id`,
    [campId, URL, JSON.stringify(changes), snapshotRef, bodyHash, JSON.stringify({ ...(opts.contentFingerprint ? { contentFingerprint: opts.contentFingerprint } : {}), ...(opts.incomplete ? { incomplete: { reason: 'provider-failure' } } : {}) }), opts.crawlRunId ?? null],
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
  await pool.query(`TRUNCATE "CrawlRun" RESTART IDENTITY CASCADE;`);
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
  it('an uncited approval that changes a reviewed value takes the requirement back out of verified', async () => {
    const campId = await seedCamp();
    const cited = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });
    expect((await review(cited.id, 'all')).verification?.dataConfidence).toBe('VERIFIED');

    // No stored snapshot: nothing to check the new value against.
    const uncited = await seedProposal(campId, { city: diff('Golden', 'Boulder', 'Located in Boulder, Colorado.') }, { snapshot: false });
    const applied = await review(uncited.id, 'all');

    const { rows } = await getTestPool().query<{ city: string }>(`SELECT city FROM "Camp" WHERE id = $1`, [campId]);
    expect(rows[0]!.city).toBe('Boulder');
    expect(applied.verification?.missingRequirements.map((requirement) => [requirement.id, requirement.status])).toEqual([['city', 'proposed']]);
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
  });

  it('an approved field with no excerpt is not counted as reviewed, even with a stored snapshot', async () => {
    const campId = await seedCamp();
    const changes = fullChanges({ sessionTimes: true });
    delete changes.city!.excerpt;
    const proposal = await seedProposal(campId, changes, { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.verification?.missingRequirements.map((requirement) => [requirement.id, requirement.status])).toEqual([['city', 'proposed']]);
  });

  it('a list counts as reviewed only when every row cites the page; a row that does not is not attested', async () => {
    const campId = await seedCamp();
    const changes = fullChanges({ sessionTimes: true });
    const ghost = { ...session(true), label: 'Session Two', startDate: '2027-06-14', endDate: '2027-06-18' };
    changes.schedules = listDiff([], [session(true), ghost], [SESSION_ONE, 'Session Two: June 14 - June 18, 2027 (waitlist only)']);
    // A list with no per-row citations at all: only its first row was ever checked.
    changes.pricing = diff([], changes.pricing!.new, 'Tuition: $450 per week');
    const proposal = await seedProposal(campId, changes, { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.provenanceErrors).toEqual([]);
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['pricing', 'sessions-verified']);
    // Only the session whose own citation was checked has claims.
    const { rows } = await getTestPool().query<{ label: string; claims: number }>(
      `SELECT s.label, (SELECT count(*)::int FROM "SurfaceClaimDefinition" d WHERE d."subjectId" = s.id) AS claims
         FROM "CampSchedule" s WHERE s."campId" = $1 ORDER BY s."startDate"`,
      [campId],
    );
    expect(rows).toEqual([{ label: 'Session One', claims: 2 }, { label: 'Session Two', claims: 0 }]);
  });

  it('a later approval whose crawl does not state the session time keeps the time and its verified claim', async () => {
    const campId = await seedCamp();
    const first = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });
    expect((await review(first.id, 'all')).verification?.dataConfidence).toBe('VERIFIED');

    // A page that does not state the time is not evidence the time was removed.
    const second = await seedProposal(campId, { schedules: listDiff([session(true)], [session(false)], [SESSION_ONE]) }, { snapshot: true });
    const applied = await review(second.id, 'all');

    expect(applied.provenanceErrors).toEqual([]);
    expect(applied.verification?.missingRequirements).toEqual([]);
    const { rows: sessions } = await getTestPool().query<{ startTime: string }>(`SELECT "startTime" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`, [campId]);
    expect(sessions).toEqual([{ startTime: '09:00' }]);
    const { rows } = await getTestPool().query<{ status: string }>(
      `SELECT e.status FROM "SurfaceVerificationEvent" e JOIN "SurfaceClaimDefinition" d ON d.id = e."claimId"
        WHERE d."fieldOrBehavior" = 'time' ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('verified');
  });

  it('approving a category together with a list that holds it records every field, with no id clash', async () => {
    const campId = await seedCamp();
    const changes: ProposedChanges = {
      category: diff('SPORTS', 'NATURE', 'Category: nature.'),
      categories: listDiff([], ['NATURE'], ['Category: nature.']),
      description: fullChanges({ sessionTimes: true }).description!,
    };
    const proposal = await seedProposal(campId, changes, { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.provenanceErrors).toEqual([]);
    const { rows } = await getTestPool().query<{ claimId: string; n: number }>(
      `SELECT "claimId", count(*)::int AS n FROM "SurfaceEvidence" WHERE "evidenceType" = 'human_attestation' GROUP BY 1 ORDER BY 1`,
    );
    // `schedules` is the fixture's intentionally-empty session list (seedCamp).
    expect(rows.map((row) => row.claimId.split('.field.')[1])).toEqual(['categories', 'category', 'description', 'schedules']);
  });

  it('refuses a single value that its own list does not hold, before writing anything', async () => {
    const campId = await seedCamp();
    const proposal = await seedProposal(campId, {
      category: diff('SPORTS', 'ARTS', 'Category: nature.'),
      categories: listDiff([], ['NATURE'], ['Category: nature.']),
    }, { snapshot: true });

    const refusal = await review(proposal.id, 'all').then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(ReviewApplyValueError);
    expect((refusal as Error).message).toContain('"category" (ARTS) is not one of the approved "categories"');
    const { rows } = await getTestPool().query<{ category: string }>(`SELECT category FROM "Camp" WHERE id = $1`, [campId]);
    expect(rows[0]!.category).toBe('SPORTS');
  });

  it('a field whose evidence cannot be written refuses the whole apply and writes nothing', async () => {
    const campId = await seedCamp();
    const changes = fullChanges({ sessionTimes: true });
    const proposal = await seedProposal(campId, { city: changes.city!, websiteUrl: changes.websiteUrl! }, { snapshot: true });
    // The id the city approval will use is already taken.
    const claimId = `camp.${campId}.field.city`;
    await persistClaim(getTestPool(), { id: claimId, subjectType: 'public-directory.camp', subjectId: campId, facet: 'public-directory.camp-profile', claimType: 'public-data.field', fieldOrBehavior: 'city' });
    await appendEvidence(getTestPool(), {
      id: `evidence.${claimId}.review.${proposal.id}`, claimId, evidenceType: 'crawl_observation', method: 'extraction',
      sourceRef: URL, excerptOrSummary: 'occupied', observedAt: new Date().toISOString(), collectedBy: 'fixture',
    });

    const refusal = await review(proposal.id, 'all').then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(ReviewApplyEvidenceError);
    expect((refusal as Error).message).toMatch(/^Nothing was applied: the review record for "city" cannot be written \(.*\)\. Trying again will not help/);
    expect((refusal as ReviewApplyEvidenceError).transient).toBe(false);
    const camp = await getTestPool().query<{ city: string; websiteUrl: string }>(`SELECT city, "websiteUrl" FROM "Camp" WHERE id = $1`, [campId]);
    expect(camp.rows[0]).toEqual({ city: '', websiteUrl: '' });
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "SurfaceEvidence" WHERE "claimId" = $1`, [`camp.${campId}.field.websiteUrl`]);
    expect(rows[0]!.n).toBe(0);
    expect((await getProposal(proposal.id))!.status).toBe('PENDING');
  });

  it('a manual edit forgets which page text the field was approved from', async () => {
    const campId = await seedCamp();
    const proposal = await seedProposal(campId, { city: fullChanges({ sessionTimes: true }).city! }, { snapshot: true, contentFingerprint: 'sha256:page-one' });
    await review(proposal.id, 'all');
    const sources = async () => (await getTestPool().query<{ fieldSources: Record<string, { contentFingerprint?: string; approvedAt?: string }> }>(
      `SELECT "fieldSources" FROM "Camp" WHERE id = $1`, [campId])).rows[0]!.fieldSources;
    expect((await sources()).city!.contentFingerprint).toBe('sha256:page-one');

    await updateAdminCampFields(campId, [['city', 'Lakewood']]);

    expect((await sources()).city!.contentFingerprint).toBeUndefined();
    expect((await sources()).city!.approvedAt).toBeTruthy();
  });
  describe('batch accept', () => {
    const run = async () => (await getTestPool().query<{ id: string }>(
      `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "totalCamps", status, "completedAt") VALUES ('test', 'MANUAL', 1, 'COMPLETED', now()) RETURNING id`)).rows[0]!.id;
    async function batchAccept(campId: string, changes: ProposedChanges, field: string, opts: { snapshot: boolean }) {
      await seedProposal(campId, changes, { ...opts, crawlRunId: await run(), contentFingerprint: 'sha256:page-one' });
      const second = await seedProposal(campId, changes, { ...opts, crawlRunId: await run(), contentFingerprint: 'sha256:page-one' });
      return {
        proposalId: second.id,
        result: await applyBatchAcceptedClaims(getTestPool(), {
          selections: [{ proposalId: second.id, field }],
          actor: REVIEWER,
          historyByCamp: await getCampProposalHistoryBatch(getTestPool(), [campId]),
        }),
      };
    }
    const records = async (campId: string, field: string) => {
      const claimId = `camp.${campId}.field.${field}`;
      const evidence = await getTestPool().query<{ evidenceType: string; kind: string | null; summary: string }>(
        `SELECT "evidenceType", metadata->>'reviewKind' AS kind, "excerptOrSummary" AS summary FROM "SurfaceEvidence" WHERE "claimId" = $1 AND id LIKE '%.review%' ORDER BY "evidenceType"::text`, [claimId]);
      const latest = await getTestPool().query<{ status: string; method: string }>(
        `SELECT status, method FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC, id DESC LIMIT 1`, [claimId]);
      const source = await getTestPool().query<{ fp: string | null }>(`SELECT "fieldSources"->$2->>'contentFingerprint' AS fp FROM "Camp" WHERE id = $1`, [campId, field]);
      return { evidence: evidence.rows, latest: latest.rows[0], fingerprint: source.rows[0]!.fp };
    };

    it('a batch-accepted field whose excerpt is on the page counts, recorded as a batch accept', async () => {
      const campId = await seedCamp();
      expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
      const { proposalId, result } = await batchAccept(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, 'city', { snapshot: true });

      expect(result.outcomes).toEqual([{ proposalId, field: 'city', status: 'applied' }]);
      expect(await records(campId, 'city')).toEqual({
        evidence: [
          { evidenceType: 'crawl_observation', kind: 'batch-accept', summary: expect.any(String) },
          { evidenceType: 'human_attestation', kind: 'batch-accept', summary: `${REVIEWER} batch-accepted the proposed "city" value under the exact-corroboration rule; its cited excerpt is on the stored page.` },
        ],
        latest: { status: 'verified', method: 'batch-accept' },
        fingerprint: 'sha256:page-one',
      });
      expect(await dataConfidence(campId)).toBe('VERIFIED');
      // Shown as a batch accept, not as an individual review.
      const display = (await loadCampTrustDisplays(campId, ['city'])).fields.city!;
      expect(display).toMatchObject({
        evidenceState: 'verified_current', label: 'Accepted in batch', acceptedInBatch: true,
        accessibleName: `Accepted in a batch by the exact-corroboration rule (${REVIEWER}); the cited excerpt is on the current source page`,
      });
    });

    it('an uncited batch-accepted field stays proposed and records no withholding fingerprint', async () => {
      const campId = await seedCamp();
      expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
      const { result } = await batchAccept(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, 'city', { snapshot: false });

      expect(result.outcomes[0]!.status).toBe('applied');
      expect(await records(campId, 'city')).toEqual({
        evidence: [{ evidenceType: 'crawl_observation', kind: 'batch-accept', summary: expect.any(String) }],
        latest: { status: 'proposed', method: 'batch-accept' },
        fingerprint: null,
      });
      expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
    });

    it('a list, even with one uncited row, is never batch-accepted', async () => {
      const campId = await seedCamp();
      const changes = fullChanges({ sessionTimes: true });
      const rows = [...(changes.pricing!.new as unknown[]), { label: 'Extended day', amount: 90, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }];
      const { proposalId, result } = await batchAccept(campId, { pricing: listDiff([], rows, ['Tuition: $450 per week', 'Extended day: $90 (not on the page)']) }, 'pricing', { snapshot: true });

      expect(result.outcomes).toEqual([{ proposalId, field: 'pricing', status: 'excluded_not_pending', message: 'Field is not a pending scalar Candidate Claim on this proposal.' }]);
      expect((await records(campId, 'pricing')).latest).toBeUndefined();
    });
  });

  it('a session stored with a Markdown label is matched, not archived and recreated, when its plain label is approved', async () => {
    const campId = await seedCamp();
    const { rows: [stored] } = await getTestPool().query<{ id: string }>(
      `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate") VALUES (gen_random_uuid()::text, $1, '**Session** One', '2027-06-07', '2027-06-11') RETURNING id`,
      [campId],
    );
    const claimId = `session.${stored!.id}.dates`;
    await persistClaim(getTestPool(), { id: claimId, subjectType: 'public-directory.camp-session', subjectId: stored!.id, facet: 'public-directory.camp-session-profile', claimType: 'public-data.session-dates', fieldOrBehavior: 'dates' });
    const old = { ...session(false), label: '**Session** One' };
    const proposal = await seedProposal(campId, { schedules: listDiff([old], [session(true)], [SESSION_ONE]) }, { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.provenanceErrors).toEqual([]);
    const { rows } = await getTestPool().query<{ id: string; label: string; archived: boolean }>(
      `SELECT id, label, "archivedAt" IS NOT NULL AS archived FROM "CampSchedule" WHERE "campId" = $1`, [campId]);
    expect(rows).toEqual([{ id: stored!.id, label: 'Session One', archived: false }]);
    const revoked = await getTestPool().query(`SELECT 1 FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 AND status = 'revoked'`, [claimId]);
    expect(revoked.rowCount).toBe(0);
  });
  it('an approval made from an incomplete read keeps no page fingerprint, whatever the proposal carries', async () => {
    const campId = await seedCamp();
    const proposal = await seedProposal(campId, { city: fullChanges({ sessionTimes: true }).city! }, { snapshot: true, contentFingerprint: 'sha256:page-one', incomplete: true });
    await review(proposal.id, 'all');
    const { rows } = await getTestPool().query<{ source: { contentFingerprint?: string; approvedAt?: string } }>(
      `SELECT "fieldSources"->'city' AS source FROM "Camp" WHERE id = $1`, [campId]);
    expect(rows[0]!.source.approvedAt).toBeTruthy();
    expect(rows[0]!.source.contentFingerprint).toBeUndefined();
  });

  it('an unreviewed list that moves the single value takes that requirement out of verified', async () => {
    const campId = await seedCamp();
    expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
    // The camp is SLEEPAWAY. No stored snapshot, so the list is applied unreviewed.
    const proposal = await seedProposal(campId, { campTypes: listDiff([], ['SUMMER_DAY'], ['Camp type: summer day camp.']) }, { snapshot: false });

    const applied = await review(proposal.id, 'all');

    const { rows } = await getTestPool().query<{ campType: string }>(`SELECT "campType" FROM "Camp" WHERE id = $1`, [campId]);
    expect(rows[0]!.campType).toBe('SUMMER_DAY');
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['campType']);
  });
  describe('a value changed outside review is not verified', () => {
    async function verifiedCamp(): Promise<string> {
      const campId = await seedCamp();
      const proposal = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });
      expect((await review(proposal.id, 'all')).verification?.dataConfidence).toBe('VERIFIED');
      return campId;
    }
    const missing = async (campId: string) => {
      const { rows } = await getTestPool().query<{ dataConfidence: string }>(`SELECT "dataConfidence" FROM "Camp" WHERE id = $1`, [campId]);
      const latest = await getTestPool().query<{ field: string; status: string }>(
        `SELECT DISTINCT ON (d.id) d."fieldOrBehavior" AS field, e.status FROM "SurfaceClaimDefinition" d
           JOIN "SurfaceVerificationEvent" e ON e."claimId" = d.id WHERE d."subjectId" = $1
          ORDER BY d.id, e."createdAt" DESC, e.id DESC`, [campId]);
      return { dataConfidence: rows[0]!.dataConfidence, unverified: latest.rows.filter((row) => row.status !== 'verified' && row.status !== 'assumed').map((row) => row.field).sort() };
    };

    it('an admin edit of a field, after which an admin can attest the camp again', async () => {
      const campId = await verifiedCamp();
      await updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER);
      expect(await missing(campId)).toEqual({ dataConfidence: 'PLACEHOLDER', unverified: ['city'] });
      expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
      expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
    });

    it('an admin edit of the age groups, which also forgets the approved page text', async () => {
      const campId = await verifiedCamp();
      await getTestPool().query(`UPDATE "Camp" SET "fieldSources" = jsonb_set("fieldSources", '{ageGroups,contentFingerprint}', '"sha256:page-one"') WHERE id = $1`, [campId]);
      await replaceAdminCampAgeGroups(campId, [{ label: 'Ages 12 - 17', minAge: 12, maxAge: 17, minGrade: null, maxGrade: null }], REVIEWER);
      expect(await missing(campId)).toEqual({ dataConfidence: 'PLACEHOLDER', unverified: ['ageGroups'] });
      const { rows } = await getTestPool().query<{ fp: string | null }>(`SELECT "fieldSources"->'ageGroups'->>'contentFingerprint' AS fp FROM "Camp" WHERE id = $1`, [campId]);
      expect(rows[0]!.fp).toBeNull();
    });

    it('an assistant edit of a field', async () => {
      const campId = await verifiedCamp();
      await updateAssistantCampFields(campId, [['registrationStatus', 'FULL']]);
      expect(await missing(campId)).toEqual({ dataConfidence: 'PLACEHOLDER', unverified: ['registrationStatus'] });
    });

    it('an approval whose evidence cannot be written changes nothing (fails closed)', async () => {
      const campId = await seedCamp();
      expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
      // The id the city approval will use is already taken, so its evidence write fails.
      const claimId = `camp.${campId}.field.city`;
      await appendEvidence(getTestPool(), {
        id: `evidence.${claimId}.review.${proposal.id}`, claimId, evidenceType: 'crawl_observation', method: 'extraction',
        sourceRef: URL, excerptOrSummary: 'occupied', observedAt: new Date().toISOString(), collectedBy: 'fixture',
      });

      const refusal = await review(proposal.id, 'all').then(() => null, (error: unknown) => error);

      // The value and its record land together or not at all: the camp keeps
      // the value it was verified with.
      expect(refusal).toBeInstanceOf(ReviewApplyEvidenceError);
      const { rows } = await getTestPool().query<{ city: string }>(`SELECT city FROM "Camp" WHERE id = $1`, [campId]);
      expect(rows[0]!.city).toBe('');
      expect(await missing(campId)).toEqual({ dataConfidence: 'VERIFIED', unverified: [] });
    });

    it('sessions: an exact duplicate row is one session, and a changed time stays unverified through later uncited approvals', async () => {
      const campId = await seedCamp();
      const s2 = (startTime: string, endTime: string) => ({ ...session(true), label: 'Session Two', startDate: '2027-06-14', endDate: '2027-06-18', startTime, endTime });
      const first = fullChanges({ sessionTimes: true });
      first.schedules = listDiff([], [session(true), s2('09:00', '15:00')], [SESSION_ONE, SESSION_TWO]);
      const cited = await seedProposal(campId, first, { snapshot: true });
      expect((await review(cited.id, 'all')).verification?.dataConfidence).toBe('VERIFIED');
      const before = [session(true), s2('09:00', '15:00')];

      const duplicated = await seedProposal(campId, {
        schedules: listDiff(before, [session(true), { ...session(true), label: '**Session One**' }, s2('10:00', '16:00')], [SESSION_ONE, SESSION_ONE, SESSION_TWO]),
      }, { snapshot: false });
      const second = await review(duplicated.id, 'all');
      expect(second.provenanceErrors).toEqual([]);
      expect(second.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['sessions-verified']);
      const { rows: sessions } = await getTestPool().query<{ label: string; startTime: string }>(
        `SELECT label, "startTime" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY "startDate"`, [campId]);
      expect(sessions).toEqual([{ label: 'Session One', startTime: '09:00' }, { label: 'Session Two', startTime: '10:00' }]);

      const again = await seedProposal(campId, { schedules: listDiff([session(true), s2('10:00', '16:00')], [session(true), s2('10:00', '16:00')], [SESSION_ONE, SESSION_TWO]) }, { snapshot: false });
      const third = await review(again.id, 'all');
      expect(third.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['sessions-verified']);
      expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
    });
  });

  it('a list whose row citations do not cover every row is not reviewed', async () => {
    const campId = await seedCamp();
    const changes = fullChanges({ sessionTimes: true });
    const two = [...(changes.pricing!.new as unknown[]), { label: 'Extended day', amount: 90, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }];
    changes.pricing = { ...listDiff([], two, ['Tuition: $450 per week']) };
    const proposal = await seedProposal(campId, changes, { snapshot: true });
    const applied = await review(proposal.id, 'all');
    // A session's price options are inherited from the camp's pricing, so they go too.
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['pricing', 'sessions-verified']);
  });
  it.each([-300_000, 300_000])('a later uncited approval wins over a cited one whatever the application clock says (%i ms off)', async (skewMs) => {
    const campId = await seedCamp();
    const cited = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });
    expect((await review(cited.id, 'all')).verification?.dataConfidence).toBe('VERIFIED');
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: Date.now() + skewMs });
    try {
      const uncited = await seedProposal(campId, { city: diff('Golden', 'Boulder', 'Located in Boulder, Colorado.') }, { snapshot: false });
      const applied = await review(uncited.id, 'all');
      expect(applied.verification?.missingRequirements.map((requirement) => [requirement.id, requirement.status])).toEqual([['city', 'proposed']]);
    } finally {
      vi.useRealTimers();
    }
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
  });

  it('only a reviewed approval records the page text it was decided on', async () => {
    const campId = await seedCamp();
    const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: false, contentFingerprint: 'sha256:page-one' });
    await review(proposal.id, 'all');
    const { rows } = await getTestPool().query<{ source: { contentFingerprint?: string; approvedAt?: string } }>(
      `SELECT "fieldSources"->'city' AS source FROM "Camp" WHERE id = $1`, [campId]);
    expect(rows[0]!.source.approvedAt).toBeTruthy();
    expect(rows[0]!.source.contentFingerprint).toBeUndefined();
  });
  it('morning and afternoon sessions with the same label and dates are two sessions, each attested only on its own row', async () => {
    const campId = await seedCamp();
    const changes = fullChanges({ sessionTimes: true });
    const pm = { ...session(true), startTime: '13:00', endTime: '16:00' };
    // The afternoon row cites text that is not on the page.
    changes.schedules = listDiff([], [session(true), pm], [SESSION_ONE, 'Session One afternoon: 1:00 PM - 4:00 PM']);
    const proposal = await seedProposal(campId, changes, { snapshot: true });

    const applied = await review(proposal.id, 'all');

    expect(applied.appliedFields).toHaveLength(9);
    // The afternoon session is its own session, so its uncited row leaves it unattested.
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['sessions-verified']);
    const { rows } = await getTestPool().query<{ startTime: string; claims: number }>(
      `SELECT s."startTime", (SELECT count(*)::int FROM "SurfaceClaimDefinition" d WHERE d."subjectId" = s.id) AS claims
         FROM "CampSchedule" s WHERE s."campId" = $1 AND s."archivedAt" IS NULL ORDER BY s."startTime"`, [campId]);
    expect(rows).toEqual([{ startTime: '09:00', claims: 2 }, { startTime: '13:00', claims: 0 }]);

    // A later list that changes the afternoon session's end time: still two
    // sessions, the morning one keeps its id. (Among sessions that share a
    // label and dates, the time is part of the identity, so the afternoon one
    // is replaced, not edited.)
    const amId = (await getTestPool().query<{ id: string }>(`SELECT id FROM "CampSchedule" WHERE "campId" = $1 AND "startTime" = '09:00'`, [campId])).rows[0]!.id;
    const again = await seedProposal(campId, { schedules: listDiff([session(true), pm], [session(true), { ...pm, endTime: '16:30' }], [SESSION_ONE, 'Session One afternoon']) }, { snapshot: false });
    await review(again.id, 'all');
    const after = await getTestPool().query<{ id: string; endTime: string }>(
      `SELECT id, "endTime" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY "startTime"`, [campId]);
    expect(after.rows.map((row) => row.endTime)).toEqual(['15:00', '16:30']);
    expect(after.rows[0]!.id).toBe(amId);
  });

  it('a deterministic evidence failure says retrying will not help; a transient one says try again', async () => {
    expect(isTransientDatabaseError(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(true);
    expect(isTransientDatabaseError(Object.assign(new Error('could not serialize'), { code: '40001' }))).toBe(true);
    expect(isTransientDatabaseError(Object.assign(new Error('connection failure'), { code: '08006' }))).toBe(true);
    expect(isTransientDatabaseError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false);
    const deterministic = new ReviewApplyEvidenceError('city', Object.assign(new Error('duplicate key'), { code: '23505' }));
    expect(deterministic.transient).toBe(false);
    expect(deterministic.message).toBe('Nothing was applied: the review record for "city" cannot be written (duplicate key). Trying again will not help: keep the current value for "city" (or reject it) and apply the rest, or report this.');
    expect(new ReviewApplyEvidenceError(null, Object.assign(new Error('deadlock detected'), { code: '40P01' })).message)
      .toBe('Nothing was applied: the record of the changed fields could not be written because the database was busy (deadlock detected). The proposal is still pending; try again.');
  });

  it('an edit withdraws a field even when its newest event was stamped in the future by an application clock', async () => {
    const campId = await seedCamp();
    expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
    const claimId = `camp.${campId}.field.city`;
    // An attestation written by an application clock five minutes fast.
    await appendEvent(getTestPool(), {
      id: `event.${claimId}.fast-clock`, claimId, status: 'assumed', type: 'verification', actor: REVIEWER, method: 'attestation',
      evidenceIds: (await getTestPool().query<{ id: string }>(`SELECT id FROM "SurfaceEvidence" WHERE "claimId" = $1 LIMIT 1`, [claimId])).rows.map((row) => row.id),
      createdAt: new Date(Date.now() + 300_000).toISOString(),
    });

    await updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER);

    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
  });

  describe('concurrent changes to one camp', () => {
    const latestCity = async (campId: string) => {
      const { rows } = await getTestPool().query<{ status: string; integrity: string | null; city: string }>(
        `SELECT e.status, ev."integrityRef" AS integrity, c.city FROM "SurfaceVerificationEvent" e
           LEFT JOIN "SurfaceEvidence" ev ON ev.id = e."evidenceIds"[1] JOIN "Camp" c ON c.id = $1
          WHERE e."claimId" = 'camp.' || $1 || '.field.city' ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1`, [campId]);
      return rows[0];
    };

    it('an attestation racing an edit never verifies a value it did not read, and nothing deadlocks', async () => {
      for (let round = 0; round < 6; round++) {
        const campId = await seedCamp();
        const outcomes = await Promise.allSettled([bulkAttestCamp(campId, REVIEWER), updateAdminCampFields(campId, [['city', `Boulder ${round}`]], REVIEWER)]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
        const latest = (await latestCity(campId))!;
        expect(latest.city).toBe(`Boulder ${round}`);
        // Either the edit came last (not verified), or the attestation did, of the edited value.
        if (latest.status === 'assumed') expect(latest.integrity).toBe(createHash('sha256').update(JSON.stringify(`Boulder ${round}`)).digest('hex'));
        else expect(latest.status).toBe('proposed');
      }
    });

    it('a review apply racing an edit ends either applied-and-reviewed or edited-and-unverified, and nothing deadlocks', async () => {
      for (let round = 0; round < 6; round++) {
        const campId = await seedCamp();
        const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
        const outcomes = await Promise.allSettled([review(proposal.id, 'all'), updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER)]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
        const latest = (await latestCity(campId))!;
        if (latest.city === 'Golden') expect(latest.status).toBe('verified');
        else expect([latest.city, latest.status]).toEqual(['Boulder', 'proposed']);
      }
    });

    it('a claim-store writer waits for an apply to finish: the apply holds the camp\'s subject lock while it writes claims', async () => {
      // The claim store's save deletes claims missing from the store it
      // loaded, so a writer that holds only the subject lock must not commit
      // in the middle of an apply. The erasure window itself is between two
      // statements and cannot be held open from a test; this pins the lock
      // that closes it.
      const pool = getTestPool();
      const campId = await seedCamp();
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS hold_once`);
      await pool.query(`CREATE OR REPLACE FUNCTION hold_evidence_insert() RETURNS trigger AS $$ BEGIN IF nextval('hold_once') = 1 THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER hold_evidence_insert BEFORE INSERT ON "SurfaceEvidence" FOR EACH ROW EXECUTE FUNCTION hold_evidence_insert()`);
      const finished: string[] = [];
      try {
        const applying = review(proposal.id, 'all').then(() => { finished.push('apply'); });
        let held = false;
        for (let i = 0; i < 200 && !held; i++) {
          held = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep'`)).rows.length > 0;
          if (!held) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(held).toBe(true);
        const writing = persistClaim(pool, {
          id: `camp.${campId}.field.description`, subjectType: 'public-directory.camp', subjectId: campId,
          facet: 'public-directory.camp-profile', claimType: 'public-data.field', fieldOrBehavior: 'description',
        }).then(() => { finished.push('writer'); });
        // Still inside the apply's 1.5 s hold: the writer must be waiting.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(finished).toEqual([]);
        await Promise.all([applying, writing]);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS hold_evidence_insert ON "SurfaceEvidence"`);
        await pool.query(`DROP FUNCTION IF EXISTS hold_evidence_insert()`);
        await pool.query(`DROP SEQUENCE IF EXISTS hold_once`);
      }
      expect([...finished].sort()).toEqual(['apply', 'writer']);
      const { rows } = await pool.query(`SELECT id FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1 ORDER BY id`, [campId]);
      expect(rows.map((row) => row.id)).toEqual([`camp.${campId}.field.city`, `camp.${campId}.field.description`, `camp.${campId}.field.schedules`]);
  });
  });
  describe('one lock order across crawls, reviews, edits and attestations', () => {
    const pool = () => getTestPool();
    const derived = async (campId: string) => projectTrustStatusToDataConfidence((await deriveCampVerification(campId)).status);
    /** Delay the next locked-client claim-store save, between its load and its save, once. */
    const delayNextSave = (ms: number) => {
      claimStoreTestHooks.afterLoad = async () => { claimStoreTestHooks.afterLoad = undefined; await new Promise((resolve) => setTimeout(resolve, ms)); };
    };
    const holdOnce = async (table: string, when: string, seconds = 1.5) => {
      await pool().query(`CREATE SEQUENCE hold_once_seq`);
      await pool().query(`CREATE FUNCTION hold_once_fn() RETURNS trigger AS $$ BEGIN IF nextval('hold_once_seq') = 1 THEN PERFORM pg_sleep(${seconds}); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await pool().query(`CREATE TRIGGER hold_once_tr BEFORE ${table} FOR EACH ROW ${when} EXECUTE FUNCTION hold_once_fn()`);
    };
    const waitSleeping = async () => {
      for (let i = 0; i < 300; i++) {
        if ((await pool().query(`SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep'`)).rows.length) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    afterEach(async () => {
      claimStoreTestHooks.afterLoad = undefined;
      verificationCacheTestHooks.beforeWrite = undefined;
      verificationCacheTestHooks.afterLoad = undefined;
      vi.useRealTimers();
      for (const table of ['"Camp"', '"SurfaceVerificationEvent"', '"CampChangeProposal"']) await pool().query(`DROP TRIGGER IF EXISTS hold_once_tr ON ${table}`);
      await pool().query(`DROP FUNCTION IF EXISTS hold_once_fn() CASCADE`);
      await pool().query(`DROP SEQUENCE IF EXISTS hold_once_seq`);
      await pool().query(`DROP FUNCTION IF EXISTS fail_once_fn() CASCADE`);
    });

    it('a crawl writing a proposal waits for an apply instead of deadlocking with it', async () => {
      const campId = await seedCamp();
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.'), campTypes: listDiff([], ['SUMMER_DAY'], ['Camp type: summer day camp.']) }, { snapshot: true });
      await holdOnce('UPDATE ON "Camp"', 'WHEN (OLD.city IS DISTINCT FROM NEW.city)');
      const applying = review(proposal.id, 'all');
      expect(await waitSleeping()).toBe(true);
      const crawling = createProposal({ campId, crawlRunId: null as unknown as string, sourceUrl: URL, rawExtraction: {}, proposedChanges: { city: diff('Golden', 'Boulder', 'x') }, overallConfidence: 0.9, extractionModel: 'm' });
      const outcomes = await Promise.allSettled([applying, crawling]);
      expect(outcomes.map((outcome) => outcome.status === 'fulfilled' ? 'ok' : (outcome.reason as { code?: string }).code ?? String(outcome.reason))).toEqual(['ok', 'ok']);
    });

    it('the attest route waits for an apply, so the apply cannot erase the claims it writes', async () => {
      const campId = await seedCamp();
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
      delayNextSave(1500);
      const applying = review(proposal.id, 'all');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const attesting = recordCampAttestationEvidence({ campId, fields: ['description', 'websiteUrl'], actor: REVIEWER, attestedAt: new Date().toISOString(), notes: 'n/a on purpose', mode: 'override' });
      await Promise.all([applying, attesting]);
      const { rows } = await pool().query<{ id: string }>(`SELECT id FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1 ORDER BY id`, [campId]);
      expect(rows.map((row) => row.id.split('.').pop())).toEqual(['city', 'description', 'schedules', 'websiteUrl']);
    });

    it('a session-claim writer waits for an apply on the camp (session subject locks)', async () => {
      const campId = await seedCamp();
      const first = fullChanges({ sessionTimes: true });
      await review((await seedProposal(campId, { schedules: first.schedules! }, { snapshot: true })).id, 'all');
      const sessionId = (await pool().query<{ id: string }>(`SELECT id FROM "CampSchedule" WHERE "campId" = $1`, [campId])).rows[0]!.id;
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
      await holdOnce('INSERT ON "SurfaceVerificationEvent"', '');
      const finished: string[] = [];
      const applying = review(proposal.id, 'all').then(() => { finished.push('apply'); });
      expect(await waitSleeping()).toBe(true);
      const writing = persistClaim(pool(), { id: `session.${sessionId}.dates`, subjectType: 'public-directory.camp-session', subjectId: sessionId, facet: 'public-directory.camp-session-profile', claimType: 'public-data.session-dates', fieldOrBehavior: 'dates' })
        .then(() => { finished.push('writer'); });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(finished).toEqual([]);
      await Promise.all([applying, writing]);
    });

    it('an assistant edit holding the camp row does not deadlock an apply', async () => {
      const campId = await seedCamp();
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
      await holdOnce('UPDATE ON "Camp"', "WHEN (NEW.description = 'assistant text')");
      const editing = updateAssistantCampFields(campId, [['description', 'assistant text']]);
      expect(await waitSleeping()).toBe(true);
      const applying = review(proposal.id, 'all');
      const outcomes = await Promise.allSettled([editing, applying]);
      expect(outcomes.map((outcome) => outcome.status === 'fulfilled' ? 'ok' : (outcome.reason as { code?: string }).code ?? String(outcome.reason))).toEqual(['ok', 'ok']);
    });

    it('Mark Verified after an edit is stamped by the database clock, even when the application clock is 5 minutes slow', async () => {
      const campId = await seedCamp();
      await bulkAttestCamp(campId, REVIEWER);
      await updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER);
      expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() - 300_000));
      try {
        await bulkAttestCamp(campId, REVIEWER);
      } finally {
        vi.useRealTimers();
      }
      expect(await derived(campId)).toBe('VERIFIED');
    });

    it('dropping the afternoon session keeps the morning session (sessions are matched against the existing ones too)', async () => {
      const campId = await seedCamp();
      const am = session(true);
      const pm = { ...am, startTime: '13:00', endTime: '16:00' };
      await review((await seedProposal(campId, { schedules: listDiff([], [pm, am], [SESSION_TWO, SESSION_ONE]) }, { snapshot: true })).id, 'all');
      const amId = (await pool().query<{ id: string }>(`SELECT id FROM "CampSchedule" WHERE "campId" = $1 AND "startTime" = '09:00'`, [campId])).rows[0]!.id;
      await review((await seedProposal(campId, { schedules: listDiff([am, pm], [am], [SESSION_ONE]) }, { snapshot: true })).id, 'all');
      const live = (await pool().query<{ id: string; startTime: string }>(`SELECT id, "startTime" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`, [campId])).rows;
      expect(live).toEqual([{ id: amId, startTime: '09:00' }]);
    });

    it('two cache refreshes cannot write out of order', async () => {
      const campId = await seedCamp();
      await bulkAttestCamp(campId, REVIEWER);
      expect(await dataConfidence(campId)).toBe('VERIFIED');
      // A refresh that derived VERIFIED is slow to write it.
      verificationCacheTestHooks.beforeWrite = async (_id, derivedConfidence) => {
        if (derivedConfidence === 'VERIFIED') await new Promise((resolve) => setTimeout(resolve, 2000));
      };
      const attest = bulkAttestCamp(campId, REVIEWER);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const edit = updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER);
      await Promise.all([attest, edit]);
      expect(await dataConfidence(campId)).toBe(await derived(campId));
      expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
    });

    it('a refresh derives under the camp lock: an edit cannot commit between its derivation and its write', async () => {
      const campId = await seedCamp();
      await bulkAttestCamp(campId, REVIEWER);
      expect(await dataConfidence(campId)).toBe('VERIFIED');
      // Once the refresh has read the claims, an edit starts. Holding the
      // lock, the refresh makes it wait; otherwise it commits in the window.
      let editing: Promise<unknown> | undefined;
      verificationCacheTestHooks.afterLoad = async () => {
        verificationCacheTestHooks.afterLoad = undefined;
        editing = updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER);
        await Promise.race([editing.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1500))]);
      };
      await refreshCampVerificationCache(campId);
      expect(editing).toBeDefined();
      await editing;
      expect(await dataConfidence(campId)).toBe(await derived(campId));
      expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
    });

    it('the cache is written only by a transaction holding the camp lock', async () => {
      const campId = await seedCamp();
      const client = await getProductionPool().connect();
      try {
        await client.query('BEGIN');
        // Another camp's lock is not this camp's.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`camp-claims:${randomUUID()}`]);
        const refusal = await refreshCampVerificationCacheOnLockedClient(client, campId).then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(CampLockNotHeldError);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`camp-claims:${campId}`]);
        expect((await refreshCampVerificationCacheOnLockedClient(client, campId)).dataConfidence).toBe('PLACEHOLDER');
        await client.query('COMMIT');
      } finally {
        // A failed assertion above leaves the transaction open; never return it to the pool open.
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('an edit whose re-derivation fails does not land, so a VERIFIED cache never outlives it (fails closed)', async () => {
      const campId = await seedCamp();
      await bulkAttestCamp(campId, REVIEWER);
      verificationCacheTestHooks.afterLoad = async () => {
        verificationCacheTestHooks.afterLoad = undefined;
        throw new Error('fixture: derivation failed');
      };
      const refusal = await updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER).then(() => null, (error: unknown) => error);
      expect((refusal as Error | null)?.message).toBe('fixture: derivation failed');
      const { rows } = await pool().query<{ city: string }>(`SELECT city FROM "Camp" WHERE id = $1`, [campId]);
      expect(rows[0]!.city).toBe('');
      expect(await dataConfidence(campId)).toBe('VERIFIED');
      expect(await derived(campId)).toBe('VERIFIED');
    });

    describe('with the production pool (3 connections)', () => {
      const settle = (promises: Promise<unknown>[]) => Promise.allSettled(promises)
        .then((results) => results.map((result) => result.status === 'fulfilled' ? 'ok' : String((result.reason as Error)?.message ?? result.reason)));
      /** Two other requests each hold a connection while `run` uses the third. */
      const withTwoConnectionsHeld = async <T>(run: () => Promise<T>) => {
        const busy = [await getProductionPool().connect(), await getProductionPool().connect()];
        try {
          return await run();
        } finally {
          for (const client of busy) client.release();
        }
      };

      it('runs at the production pool size', () => {
        expect(getProductionPool().options.max).toBe(3);
      });

      it('three concurrent cache refreshes of one camp all succeed', async () => {
        const campId = await seedCamp();
        await bulkAttestCamp(campId, REVIEWER);
        expect(await settle([refreshCampVerificationCache(campId), refreshCampVerificationCache(campId), refreshCampVerificationCache(campId)])).toEqual(['ok', 'ok', 'ok']);
        expect(await dataConfidence(campId)).toBe('VERIFIED');
      }, 60_000);

      it('a crawl proposal, Mark Verified and a refresh racing on one camp all succeed, and the cache matches the claims', async () => {
        for (let round = 0; round < 5; round++) {
          const campId = await seedCamp();
          const outcomes = await settle([
            createProposal({ campId, crawlRunId: null as unknown as string, sourceUrl: URL, rawExtraction: {}, proposedChanges: { city: diff('', 'Golden', 'Golden') }, overallConfidence: 0.9, extractionModel: 'm' }),
            bulkAttestCamp(campId, REVIEWER),
            refreshCampVerificationCache(campId),
          ]);
          expect(outcomes).toEqual(['ok', 'ok', 'ok']);
          expect(await dataConfidence(campId)).toBe(await derived(campId));
        }
      }, 60_000);

      it('an edit, Mark Verified, an attestation and an apply each succeed while two other requests hold connections, and the cache matches the claims', async () => {
        const campId = await seedCamp();
        await bulkAttestCamp(campId, REVIEWER);
        expect(await dataConfidence(campId)).toBe('VERIFIED');

        expect(await withTwoConnectionsHeld(() => settle([updateAdminCampFields(campId, [['city', 'Boulder']], REVIEWER)]))).toEqual(['ok']);
        expect([await dataConfidence(campId), await derived(campId)]).toEqual(['PLACEHOLDER', 'PLACEHOLDER']);

        expect(await withTwoConnectionsHeld(() => settle([bulkAttestCamp(campId, REVIEWER)]))).toEqual(['ok']);
        expect([await dataConfidence(campId), await derived(campId)]).toEqual(['VERIFIED', 'VERIFIED']);

        await updateAssistantCampFields(campId, [['description', 'assistant text']]);
        expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
        expect(await withTwoConnectionsHeld(() => settle([recordCampAttestationEvidence({ campId, fields: ['description'], actor: REVIEWER, attestedAt: new Date().toISOString(), notes: 'checked', mode: 'override' })]))).toEqual(['ok']);
        expect([await dataConfidence(campId), await derived(campId)]).toEqual(['VERIFIED', 'VERIFIED']);

        const proposal = await seedProposal(campId, { city: diff('Boulder', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
        expect(await withTwoConnectionsHeld(() => settle([review(proposal.id, 'all')]))).toEqual(['ok']);
        expect(await dataConfidence(campId)).toBe(await derived(campId));
      }, 120_000);
    });

    it('a transient database error anywhere in the apply is reported as retryable', async () => {
      const campId = await seedCamp();
      const proposal = await seedProposal(campId, { city: diff('', 'Golden', 'Located in Golden, Colorado.') }, { snapshot: true });
      await pool().query(`CREATE FUNCTION fail_once_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture: could not serialize' USING ERRCODE = 'serialization_failure'; END $$ LANGUAGE plpgsql`);
      await pool().query(`CREATE TRIGGER fail_once_tr BEFORE UPDATE ON "Camp" FOR EACH ROW WHEN (OLD.city IS DISTINCT FROM NEW.city) EXECUTE FUNCTION fail_once_fn()`);
      try {
        const refusal = await review(proposal.id, 'all').then(() => null, (error: unknown) => error);
        expect(refusal).toBeInstanceOf(ReviewApplyBusyError);
        expect((refusal as Error).message).toBe('Nothing was applied: the database was busy (fixture: could not serialize). The proposal is still pending; try again.');
      } finally {
        await pool().query(`DROP TRIGGER IF EXISTS fail_once_tr ON "Camp"`);
      }
      expect((await getProposal(proposal.id))!.status).toBe('PENDING');
    });
  });
});
