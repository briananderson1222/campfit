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
import { appendEvidence, persistClaim } from '@/lib/admin/claim-store';
import { replaceAdminCampAgeGroups, updateAdminCampFields } from '@/lib/admin/camp-repository';
import { updateAssistantCampFields } from '@/lib/admin/entity-admin-repository';
import { applyBatchAcceptedClaims, ReviewApplyEvidenceError, ReviewApplyValueError } from '@/lib/admin/review-apply';
import { getCampProposalHistoryBatch } from '@/lib/admin/review-repository';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import type { FieldDiff, ProposedChanges } from '@/lib/admin/types';
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

/** A list change whose every row cites its own line of the page. */
function listDiff(old: unknown, rows: unknown[], excerpts: string[]): FieldDiff {
  return { ...diff(old, rows, excerpts[0]!), rowCitations: excerpts.map((excerpt) => ({ excerpt })) };
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

async function seedCamp(): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl")
     VALUES ($1, 'Aspen Grove', 'SLEEPAWAY', 'SPORTS', '', '', '') RETURNING id`,
    [`aspen-grove-${randomUUID()}`],
  );
  return rows[0]!.id;
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

  it('a later approval that removes a session time drops the time claim', async () => {
    const campId = await seedCamp();
    const first = await seedProposal(campId, fullChanges({ sessionTimes: true }), { snapshot: true });
    expect((await review(first.id, 'all')).verification?.dataConfidence).toBe('VERIFIED');

    const second = await seedProposal(campId, { schedules: listDiff([session(true)], [session(false)], [SESSION_ONE]) }, { snapshot: true });
    const applied = await review(second.id, 'all');

    expect(applied.provenanceErrors).toEqual([]);
    expect(applied.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['sessions-verified']);
    const { rows } = await getTestPool().query<{ status: string }>(
      `SELECT e.status FROM "SurfaceVerificationEvent" e JOIN "SurfaceClaimDefinition" d ON d.id = e."claimId"
        WHERE d."fieldOrBehavior" = 'time' ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('proposed');
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
    expect(rows.map((row) => row.claimId.split('.field.')[1])).toEqual(['categories', 'category', 'description']);
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
    expect((refusal as Error).message).toMatch(/^Nothing was applied: the review record for "city" could not be written/);
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
  it('a batch accept applies the value but is not the human review a verified requirement needs', async () => {
    const campId = await seedCamp();
    expect((await bulkAttestCamp(campId, REVIEWER)).dataConfidence).toBe('VERIFIED');
    const run = async () => (await getTestPool().query<{ id: string }>(
      `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "totalCamps", status, "completedAt") VALUES ('test', 'MANUAL', 1, 'COMPLETED', now()) RETURNING id`)).rows[0]!.id;
    const city = { city: fullChanges({ sessionTimes: true }).city! };
    await seedProposal(campId, city, { snapshot: true, crawlRunId: await run() });
    const second = await seedProposal(campId, city, { snapshot: true, crawlRunId: await run() });

    const result = await applyBatchAcceptedClaims(getTestPool(), {
      selections: [{ proposalId: second.id, field: 'city' }],
      actor: REVIEWER,
      historyByCamp: await getCampProposalHistoryBatch(getTestPool(), [campId]),
    });

    expect(result.outcomes).toEqual([{ proposalId: second.id, field: 'city', status: 'applied' }]);
    const claimId = `camp.${campId}.field.city`;
    const evidence = await getTestPool().query<{ evidenceType: string; kind: string | null }>(
      `SELECT "evidenceType", metadata->>'reviewKind' AS kind FROM "SurfaceEvidence" WHERE "claimId" = $1 AND id LIKE '%.review%' ORDER BY id`, [claimId]);
    expect(evidence.rows).toEqual([{ evidenceType: 'crawl_observation', kind: 'batch-accept' }]);
    const latest = await getTestPool().query<{ status: string; method: string; notes: string }>(
      `SELECT status, method, notes FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [claimId]);
    expect(latest.rows[0]).toEqual({
      status: 'proposed', method: 'batch-accept',
      notes: 'Accepted in a batch by the exact-corroboration rule. Applied, not individually reviewed, so not verified.',
    });
    // The attested city was replaced by a value nobody reviewed.
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
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

    it('sessions: a proposal listing one session twice is refused, and a changed time stays unverified through later uncited approvals', async () => {
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
      const refusal = await review(duplicated.id, 'all').then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(ReviewApplyValueError);
      expect((refusal as Error).message).toContain('"schedules" lists the same session more than once ("**Session One**")');
      const { rows: unchanged } = await getTestPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM "CampSchedule" WHERE "campId" = $1 AND "startTime" = '10:00'`, [campId]);
      expect(unchanged[0]!.n).toBe(0);

      const changed = await seedProposal(campId, { schedules: listDiff(before, [session(true), s2('10:00', '16:00')], [SESSION_ONE, SESSION_TWO]) }, { snapshot: false });
      const second = await review(changed.id, 'all');
      expect(second.provenanceErrors).toEqual([]);
      expect(second.verification?.missingRequirements.map((requirement) => requirement.id)).toEqual(['sessions-verified']);

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
});
