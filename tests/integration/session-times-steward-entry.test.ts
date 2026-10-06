/**
 * Session times through review, the missing-requirements guidance, and a
 * steward's entry of a missing value as their attestation, against a
 * throwaway Postgres through the real review-apply and steward-entry paths.
 * The stored snapshot is real; only its store is in memory.
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

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));
vi.mock('@/lib/admin/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/access')>()),
  requireAdminAccess: requireAdminAccessMock,
}));

import { getPool as getProductionPool } from '@/lib/db';
import { POST as stewardEntryRoute } from '@/app/api/admin/camps/[campId]/steward-entry/route';
import { applyProposalReview } from '@/lib/admin/review-apply';
import { getProposal } from '@/lib/admin/review-repository';
import { verificationCacheTestHooks } from '@/lib/admin/verification-authority';
import { loadMissingRequirements } from '@/lib/admin/missing-requirements';
import { parseStewardEntry as parseEntry, recordStewardEntry, StewardEntryNotFoundError, StewardEntryValidationError } from '@/lib/admin/steward-entry';
import { bulkAttestCamp } from '@/lib/admin/bulk-attestation';
import { deriveCampAndSessionVerification, deriveCampVerification, deriveSessionVerification } from '@/lib/admin/verification-authority';
import { createHash } from 'node:crypto';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import type { FieldDiff, ProposedChanges } from '@/lib/admin/types';
import { computeDiff } from '@/lib/ingestion/diff-engine';
import type { Camp } from '@/lib/types';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const REVIEWER = 'reviewer@campfit.test';
const STEWARD = 'steward@campfit.test';
const URL = 'https://larkspur.example.test/summer';
const PHONE = '(555) 010-0199';
const WEEK_ONE = 'Week 1: June 14 - June 18, 2027';
const DAILY = 'Camp runs 9:00 AM - 3:30 PM every day.';

/** The stored page. Every excerpt below is one of its lines, verbatim and unique. */
const PAGE = [
  'Larkspur Meadow is a week-long outdoor science day camp.',
  'Camp type: summer day camp.',
  'Category: nature.',
  'Registration is open now.',
  'Located in Golden, Colorado.',
  'Website: https://larkspur.example.test/',
  'Ages 7 - 11',
  'Tuition: $395 per week',
  WEEK_ONE,
  'Week 2: June 21 - June 25, 2027',
  DAILY,
  'Ages 12 - 14 join the counselor program.',
].join('\n');

function diff(old: unknown, next: unknown, excerpt: string): FieldDiff {
  return { old, new: next, confidence: 0.9, excerpt, sourceUrl: URL, mode: 'update' };
}

function listDiff(old: unknown, rows: unknown[], citations: FieldDiff['rowCitations']): FieldDiff {
  return { ...diff(old, rows, citations![0]!.excerpt), rowCitations: citations };
}

function weekOne(time: { startTime: string; endTime: string } | null) {
  return { label: 'Week 1', startDate: '2027-06-14', endDate: '2027-06-18', startTime: time?.startTime ?? null, endTime: time?.endTime ?? null, earlyDropOff: null, latePickup: null };
}

/** One cited change for every Verified Camp requirement; the session row as given. */
function fullChanges(schedules: FieldDiff, omit: readonly string[] = []): ProposedChanges {
  const all: ProposedChanges = {
    description: diff('', 'A week-long outdoor science day camp.', 'Larkspur Meadow is a week-long outdoor science day camp.'),
    campTypes: listDiff([], ['SUMMER_DAY'], [{ excerpt: 'Camp type: summer day camp.' }]),
    categories: listDiff([], ['NATURE'], [{ excerpt: 'Category: nature.' }]),
    registrationStatus: diff('UNKNOWN', 'OPEN', 'Registration is open now.'),
    city: diff('', 'Golden', 'Located in Golden, Colorado.'),
    websiteUrl: diff(URL, 'https://larkspur.example.test/', 'Website: https://larkspur.example.test/'),
    ageGroups: listDiff([], [{ label: 'Ages 7 - 11', minAge: 7, maxAge: 11, minGrade: null, maxGrade: null }], [{ excerpt: 'Ages 7 - 11' }]),
    pricing: listDiff([], [{ label: 'Tuition', amount: 395, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }], [{ excerpt: 'Tuition: $395 per week' }]),
    schedules,
  };
  for (const field of omit) delete all[field];
  return all;
}

const CITED_TIME = listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE, times: [{ excerpt: DAILY }] }]);
const NO_TIME = listDiff([], [weekOne(null)], [{ excerpt: WEEK_ONE }]);

async function seedCamp(): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl", "contactPhone")
     VALUES ($1, 'Larkspur Meadow', 'SLEEPAWAY', 'SPORTS', '', '', $2, $3) RETURNING id`,
    [`larkspur-${randomUUID()}`, URL, PHONE],
  );
  return rows[0]!.id;
}

async function seedProposal(campId: string, changes: ProposedChanges) {
  const bodyHash = sha256Hex(PAGE);
  const snapshot = { sourceId: `camp-${campId}`, url: URL, fetchedAt: '2026-09-30T12:00:00.000Z', status: 200, contentType: 'text' as const, body: PAGE, bodyHash, headers: {} };
  fixture.store ??= createInMemorySnapshotStore();
  await (fixture.store as SnapshotStore).put(snapshot as never);
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status, "snapshotRef", "snapshotBodyHash", "rawExtraction")
     VALUES ($1, $2, $3::jsonb, 0.9, 'test-extraction-model', 'PENDING', $4, $5, '{}'::jsonb) RETURNING id`,
    [campId, URL, JSON.stringify(changes), buildSnapshotSourceRef(snapshot as never), bodyHash],
  );
  return (await getProposal(rows[0]!.id))!;
}

/** Approve every item through the real Survey session, then apply. */
async function approveAll(changes: ProposedChanges, campId: string) {
  const proposal = await seedProposal(campId, changes);
  const reviewSession = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
  const events = buildReviewSessionEvents({
    ...(reviewSession.snapshot as ReviewQueueSessionState),
    decisionsByItemName: Object.fromEntries(reviewSession.snapshot.items.map((item) => [item.metadata.name, 'accept-proposed' as const])),
  });
  await replaceSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId: reviewSession.id, proposal, events, actorEmail: REVIEWER });
  return applyProposalReview({ proposalId: proposal.id, reviewSessionId: reviewSession.id, reviewer: REVIEWER, keepPending: false });
}

async function dataConfidence(campId: string): Promise<string> {
  const { rows } = await getTestPool().query<{ dataConfidence: string }>(`SELECT "dataConfidence" FROM "Camp" WHERE id = $1`, [campId]);
  return rows[0]!.dataConfidence;
}

async function sessionOf(campId: string) {
  const { rows } = await getTestPool().query<{ id: string; startTime: string | null; endTime: string | null }>(
    `SELECT id, "startTime", "endTime" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY "startDate"`, [campId]);
  return rows;
}

/** The time claim's newest event, and the evidence it cites. */
async function timeClaim(sessionId: string) {
  const pool = getTestPool();
  const claimId = `session.${sessionId}.time`;
  const event = (await pool.query<{ status: string; method: string; actor: string; evidenceIds: string[] }>(
    `SELECT status, method, actor, "evidenceIds" FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [claimId])).rows[0];
  if (!event) return null;
  const evidence = (await pool.query<{ evidenceType: string; method: string; sourceRef: string; excerptOrSummary: string; metadata: Record<string, unknown> }>(
    `SELECT "evidenceType", method, "sourceRef", "excerptOrSummary", metadata FROM "SurfaceEvidence" WHERE id = ANY($1::text[])`, [event.evidenceIds])).rows;
  return { event, evidence };
}

beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  fixture.store = null;
  verificationCacheTestHooks.beforeWrite = undefined;
  requireAdminAccessMock.mockReset();
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('a crawled session time', () => {
  it('approved with its own citation on the page, verifies the session and the camp', async () => {
    const campId = await seedCamp();
    const result = await approveAll(fullChanges(CITED_TIME), campId);
    expect(result.verification).toMatchObject({ dataConfidence: 'VERIFIED', missingRequirements: [] });
    expect(await dataConfidence(campId)).toBe('VERIFIED');
    const [session] = await sessionOf(campId);
    expect(session).toMatchObject({ startTime: '9:00 AM', endTime: '3:30 PM' });
    const claim = (await timeClaim(session!.id))!;
    expect(claim.event.status).toBe('verified');
    // The time is attested from the text that states it, not the dates' line.
    expect(claim.evidence.map((e) => e.excerptOrSummary)).toContain(DAILY);
  });

  it('with no citation of its own is not attested, and the camp is not verified', async () => {
    const campId = await seedCamp();
    const uncited = listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE }]);
    const result = await approveAll(fullChanges(uncited), campId);
    expect(result.verification).toMatchObject({ dataConfidence: 'PLACEHOLDER', missingRequirements: [expect.objectContaining({ id: 'sessions-verified' })] });
    const [session] = await sessionOf(campId);
    expect(await timeClaim(session!.id)).toBeNull();
  });

  it('citing text that does not state it is not attested, though the text is on the page', async () => {
    const campId = await seedCamp();
    const wrong = listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE, times: [{ excerpt: 'Ages 12 - 14 join the counselor program.' }] }]);
    const result = await approveAll(fullChanges(wrong), campId);
    expect(result.verification).toMatchObject({ dataConfidence: 'PLACEHOLDER', missingRequirements: [expect.objectContaining({ id: 'sessions-verified' })] });
    const [session] = await sessionOf(campId);
    expect(await timeClaim(session!.id)).toBeNull();
  });
});

describe('the missing-requirements guidance', () => {
  it('lists every requirement the derivation reports missing, with the camp\'s website and phone', async () => {
    const campId = await seedCamp();
    // Nothing reviewed yet: every requirement is missing.
    const before = (await loadMissingRequirements(campId))!;
    expect(before.dataConfidence).toBe('PLACEHOLDER');
    // No sessions yet: an empty session list is a gap too, offered as intentionally empty.
    expect(before.camp.map((item) => item.requirementId).sort()).toEqual(
      ['ageGroups', 'campType', 'category', 'city', 'description', 'pricing', 'registrationStatus', 'sessions-verified', 'websiteUrl'].sort());
    expect(before.camp.filter((item) => item.intentionallyEmpty).map((item) => item.intentionallyEmpty!.field).sort()).toEqual(['ageGroups', 'pricing', 'schedules']);
    expect(before.websiteUrl).toBe(URL);
    expect(before.contactPhone).toBe(PHONE);

    await approveAll(fullChanges(NO_TIME, ['city']), campId);
    const after = (await loadMissingRequirements(campId))!;
    expect(after.camp.map((item) => item.requirementId)).toEqual(['city', 'sessions-verified']);
    expect(after.camp[0]!.entry).toMatchObject({ field: 'city', input: 'text', current: '' });
    const [session] = await sessionOf(campId);
    expect(after.sessions).toEqual([expect.objectContaining({ scheduleId: session!.id, timeEntry: true })]);
    expect(after.sessions[0]!.missing.map((item) => item.attribute)).toEqual(['time']);
    expect(after.sessions[0]!.missing[0]!.detail).toContain('does not state when this session starts and ends');
  });
});

describe('a steward entering a missing value', () => {
  it('records a session time as the steward\'s attestation, and the camp reaches VERIFIED', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
    const [session] = await sessionOf(campId);

    const result = await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD);
    expect(result).toEqual({ dataConfidence: 'VERIFIED', gapRequirementIds: [] });
    expect(await dataConfidence(campId)).toBe('VERIFIED');
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: '9:00 AM', endTime: '3:30 PM' });

    const claim = (await timeClaim(session!.id))!;
    expect(claim.event).toEqual({ status: 'assumed', method: 'steward-entry', actor: STEWARD, evidenceIds: [expect.any(String)] });
    expect(claim.evidence).toEqual([expect.objectContaining({
      evidenceType: 'human_attestation',
      method: 'attestation',
      sourceRef: `campfit-steward:${STEWARD}`,
      metadata: expect.objectContaining({ reviewKind: 'steward-entry', enteredValue: { startTime: '9:00 AM', endTime: '3:30 PM' } }),
    })]);
    expect((await loadMissingRequirements(campId))!.dataConfidence).toBe('VERIFIED');
  });

  it('records a single-value camp requirement the same way', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME, ['city']), campId);
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');

    const result = await recordStewardEntry(campId, { kind: 'camp-field', field: 'city', value: 'Golden' }, STEWARD);
    expect(result.dataConfidence).toBe('VERIFIED');
    const pool = getTestPool();
    const camp = (await pool.query<{ city: string; fieldSources: Record<string, { attestedBy?: string }> }>(`SELECT city, "fieldSources" FROM "Camp" WHERE id = $1`, [campId])).rows[0]!;
    expect(camp.city).toBe('Golden');
    expect(camp.fieldSources.city?.attestedBy).toBe(STEWARD);
    const event = (await pool.query<{ status: string; method: string }>(
      `SELECT status, method FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [`camp.${campId}.field.city`])).rows[0];
    expect(event).toEqual({ status: 'assumed', method: 'steward-entry' });
  });

  it('waits for the camp\'s claim lock, like every other claim writer', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);

    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`camp-claims:${campId}`]);
      let settled = false;
      const entry = recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD)
        .finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false);
      expect((await sessionOf(campId))[0]!.startTime).toBeNull();
      await holder.query('COMMIT');
      await expect(entry).resolves.toMatchObject({ dataConfidence: 'VERIFIED' });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    expect((await sessionOf(campId))[0]!.startTime).toBe('9:00 AM');
  });

  it('changes nothing when the cache cannot be written: the value, the attestation and the cache commit together', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    verificationCacheTestHooks.beforeWrite = async () => { throw new Error('fixture: cache write failed'); };

    await expect(recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD))
      .rejects.toThrow('fixture: cache write failed');
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: null, endTime: null });
    expect(await timeClaim(session!.id)).toBeNull();
    expect(await dataConfidence(campId)).toBe('PLACEHOLDER');
  });

  it('refuses a session of another camp', async () => {
    const campId = await seedCamp();
    const other = await seedCamp();
    await approveAll(fullChanges(NO_TIME), other);
    const [session] = await sessionOf(other);
    await expect(recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD))
      .rejects.toBeInstanceOf(StewardEntryNotFoundError);
    expect((await sessionOf(other))[0]!.startTime).toBeNull();
  });
});

describe('a later crawl after a steward entry', () => {
  async function currentCamp(campId: string): Promise<Camp> {
    const { rows } = await getTestPool().query(
      `SELECT label, to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "startTime", "endTime", "earlyDropOff", "latePickup"
         FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`, [campId]);
    return { schedules: rows } as unknown as Camp;
  }

  it('does not overwrite the steward\'s time: a page with no time proposes nothing, a different time is proposed for review', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD);

    const crawledRow = (time: { startTime: string; endTime: string } | null) => [weekOne(time)];
    const silent = computeDiff(await currentCamp(campId), { schedules: crawledRow(null) } as never, {}, {}, {}, URL, {}, { schedules: [{ excerpt: WEEK_ONE }] });
    expect(silent.schedules).toBeUndefined();

    const different = computeDiff(await currentCamp(campId), { schedules: crawledRow({ startTime: '8:30 AM', endTime: '2:30 PM' }) } as never, {}, {}, {}, URL, {}, { schedules: [{ excerpt: WEEK_ONE }] });
    expect((different.schedules!.new as { startTime: string }[])[0]!.startTime).toBe('8:30 AM');
    // Proposed, not applied: the steward's value and its attestation stand until a reviewer decides.
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: '9:00 AM', endTime: '3:30 PM' });
    expect((await timeClaim(session!.id))!.event.method).toBe('steward-entry');
    expect(await dataConfidence(campId)).toBe('VERIFIED');
  });

  it('approving a later session list that does not state the time keeps the steward\'s time and its attestation', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD);

    // The crawl reads the same session with no time, and a new second session.
    const weekTwo = { ...weekOne(null), label: 'Week 2', startDate: '2027-06-21', endDate: '2027-06-25' };
    const changes = computeDiff(await currentCamp(campId), { schedules: [weekOne(null), weekTwo] } as never, {}, {}, {}, URL, {},
      { schedules: [{ excerpt: WEEK_ONE }, { excerpt: 'Week 2: June 21 - June 25, 2027' }] });
    // Week 1 is proposed with the stored time, which the page did not state.
    expect((changes.schedules!.new as { startTime: string | null }[]).map((row) => row.startTime)).toEqual(['9:00 AM', null]);
    await approveAll(changes, campId);
    const sessions = await sessionOf(campId);
    expect(sessions.map((s) => [s.id === session!.id, s.startTime, s.endTime])).toEqual([[true, '9:00 AM', '3:30 PM'], [false, null, null]]);
    // The approval did not change the time, so the steward's attestation still governs it.
    expect((await timeClaim(session!.id))!.event).toMatchObject({ status: 'assumed', method: 'steward-entry' });
  });
});

describe('an approval after a steward entry', () => {
  it('a list that carries no time (a first-pass crawl shape, old: null) keeps the steward\'s time', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD);

    await approveAll({ schedules: { ...NO_TIME, old: null } }, campId);
    expect((await sessionOf(campId))[0]).toMatchObject({ id: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' });
    expect((await timeClaim(session!.id))!.event).toMatchObject({ status: 'assumed', method: 'steward-entry' });
    expect(await dataConfidence(campId)).toBe('VERIFIED');
  });

  it('a time the crawl kept from the stored session does not rewind a newer steward entry', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD);
    // A proposal built now keeps 9:00-3:30 (the page states no time) ...
    const kept = listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' }), { ...weekOne(null), label: 'Week 2', startDate: '2027-06-21', endDate: '2027-06-25' }],
      [{ excerpt: WEEK_ONE }, { excerpt: 'Week 2: June 21 - June 25, 2027' }]);
    // ... then the steward corrects the time before it is approved.
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '8:00 AM', endTime: '2:00 PM' }, STEWARD);
    await approveAll({ schedules: kept }, campId);
    expect((await sessionOf(campId)).find((s) => s.id === session!.id)).toMatchObject({ startTime: '8:00 AM', endTime: '2:00 PM' });
    expect((await timeClaim(session!.id))!.event).toMatchObject({ status: 'assumed', method: 'steward-entry' });
  });
});

describe('a cited time shown unchanged to the reviewer', () => {
  it('does not rewind a time a steward changed after the proposal was built', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME), campId);
    const [session] = await sessionOf(campId);
    // The crawl reads Week 1 at 9:00-3:30 again (unchanged, cited) and a new Week 2.
    const week2 = { ...weekOne(null), label: 'Week 2', startDate: '2027-06-21', endDate: '2027-06-25' };
    const proposal = listDiff([weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' }), week2],
      [{ excerpt: WEEK_ONE, times: [{ excerpt: DAILY }] }, { excerpt: 'Week 2: June 21 - June 25, 2027' }]);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '8:00 AM', endTime: '2:00 PM' }, STEWARD);
    await approveAll({ schedules: proposal }, campId);
    expect((await sessionOf(campId)).find((s) => s.id === session!.id)).toMatchObject({ startTime: '8:00 AM', endTime: '2:00 PM' });
    expect((await timeClaim(session!.id))!.event).toMatchObject({ status: 'assumed', method: 'steward-entry' });
  });
});

describe('POST /api/admin/camps/[campId]/steward-entry', () => {
  function post(campId: string, body: unknown) {
    return stewardEntryRoute(
      new Request(`http://localhost/api/admin/camps/${campId}/steward-entry`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ campId }) },
    );
  }

  it('records the signed-in steward\'s entry, refuses a time with no am/pm, and refuses without access', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);

    requireAdminAccessMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await post(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00 AM', endTime: '3:30 PM' })).status).toBe(401);

    requireAdminAccessMock.mockResolvedValue({ access: { userId: 'u1', email: STEWARD, isAdmin: false, isModerator: true, communities: ['denver'] } });
    const vague = await post(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9:00', endTime: '3:30' });
    expect(vague.status).toBe(400);
    expect((await vague.json()).error).toContain('am/pm');
    expect((await sessionOf(campId))[0]!.startTime).toBeNull();
    const backwards = await post(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '3:30 PM', endTime: '9:00 AM' });
    expect(backwards.status).toBe(400);
    expect((await post(campId, { kind: 'camp-field', field: 'campType', value: 'SUMMER_DAY' })).status).toBe(400);

    const ok = await post(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '9am', endTime: '3:30pm' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ dataConfidence: 'VERIFIED', gapRequirementIds: [] });
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: '9:00 AM', endTime: '3:30 PM' });
    expect((await timeClaim(session!.id))!.event.actor).toBe(STEWARD);
  });
});

describe('an empty required list', () => {
  async function campWithReviewedSession(omit: readonly string[]) {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME, omit), campId);
    return campId;
  }
  const latest = async (claimId: string) => (await getTestPool().query<{ status: string; method: string }>(
    `SELECT status, method FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [claimId])).rows[0];

  it('is not attested by Mark Verified: the camp stays below VERIFIED and the gap is listed, with no Mark Verified advice', async () => {
    const campId = await campWithReviewedSession(['pricing']);
    const result = await bulkAttestCamp(campId, STEWARD);
    expect(result.dataConfidence).toBe('PLACEHOLDER');
    // The session's price options follow the empty pricing, so the sessions are a gap too.
    expect(result.gapRequirementIds).toEqual(['pricing', 'sessions-verified']);
    expect(result.attestedFieldCount).toBe(7);
    expect(await latest(`camp.${campId}.field.pricing`)).toBeUndefined();
    // The session's price options follow the camp's pricing: not verified either.
    const [session] = await sessionOf(campId);
    const sessionRollup = await deriveSessionVerification(session!.id);
    expect(sessionRollup.requirements.find((r) => r.id === 'price-options')!.status).not.toBe('verified');
    const guidance = (await loadMissingRequirements(campId))!;
    const pricing = guidance.camp.find((item) => item.requirementId === 'pricing')!;
    expect(pricing.intentionallyEmpty).toEqual({ field: 'pricing' });
    expect(pricing.detail).not.toMatch(/Mark Verified/);
  });

  it('becomes VERIFIED only through an explicit, reasoned "intentionally empty" attestation of its own kind', async () => {
    const campId = await campWithReviewedSession(['pricing']);
    await bulkAttestCamp(campId, STEWARD);
    const result = await recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'pricing', reason: 'The camp office said the program is free.' }, STEWARD);
    expect(result).toEqual({ dataConfidence: 'VERIFIED', gapRequirementIds: [] });
    expect(await latest(`camp.${campId}.field.pricing`)).toEqual({ status: 'assumed', method: 'intentionally-empty' });
    const evidence = (await getTestPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "SurfaceEvidence" WHERE "claimId" = $1`, [`camp.${campId}.field.pricing`])).rows;
    expect(evidence).toEqual([{ metadata: expect.objectContaining({ reviewKind: 'intentionally-empty', reason: 'The camp office said the program is free.' }) }]);
  });

  it('is refused as "intentionally empty" when the list has rows, and without a reason', async () => {
    const campId = await campWithReviewedSession([]);
    await expect(recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'pricing', reason: 'free' }, STEWARD)).rejects.toBeInstanceOf(StewardEntryValidationError);
    expect(() => parseEntry({ kind: 'intentionally-empty', field: 'pricing', reason: '  ' })).toThrow('A reason is required');
  });

  it('does not count an earlier attestation that attested nothing (a Mark Verified before this change)', async () => {
    const campId = await campWithReviewedSession(['pricing']);
    await bulkAttestCamp(campId, STEWARD);
    // What Mark Verified used to write for an empty list: an attestation of hash(null).
    const pool = getTestPool();
    const claimId = `camp.${campId}.field.pricing`;
    await pool.query(`INSERT INTO "SurfaceClaimDefinition" (id, "subjectType", "subjectId", facet, "claimType", "fieldOrBehavior", "verificationPolicyId", "impactLevel", "createdAt", "updatedAt")
      SELECT $1, "subjectType", "subjectId", facet, "claimType", 'pricing', "verificationPolicyId", "impactLevel", now(), now() FROM "SurfaceClaimDefinition" WHERE id = $2`, [claimId, `camp.${campId}.field.ageGroups`]);
    await pool.query(`INSERT INTO "SurfaceEvidence" (id, "claimId", "evidenceType", method, "sourceRef", "excerptOrSummary", "observedAt", "collectedBy") VALUES ($1, $2, 'attestation', 'attestation', 'admin:x', 'legacy', now(), 'x')`, [`ev.legacy.${campId}`, claimId]);
    await pool.query(`INSERT INTO "SurfaceVerificationEvent" (id, "claimId", status, type, actor, method, "evidenceIds", "createdAt") VALUES ($1, $2, 'assumed', 'verification', 'x', 'attestation', ARRAY[$3], now() + interval '1 second')`, [`evt.legacy.${campId}`, claimId, `ev.legacy.${campId}`]);
    expect((await deriveCampVerification(campId)).status).not.toBe('verified');
  });

  it('Mark Verified attests a list from its rows, not from a column that does not exist', async () => {
    const campId = await campWithReviewedSession([]);
    await bulkAttestCamp(campId, STEWARD);
    const rows = (await getTestPool().query(`SELECT label, amount::float AS amount, unit, "durationWeeks", "ageQualifier", "discountNotes" FROM "CampPricing" WHERE "campId" = $1 ORDER BY label, amount, id`, [campId])).rows;
    const { rows: evidence } = await getTestPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT e.metadata FROM "SurfaceEvidence" e WHERE e."claimId" = $1 AND e."evidenceType" = 'attestation'`, [`camp.${campId}.field.pricing`]);
    const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(evidence)).toContain(hash);
    expect(JSON.stringify(evidence)).not.toContain(createHash('sha256').update('null').digest('hex'));
  });

  it('a camp with no sessions is a gap until its empty session list is attested as intentional', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME, ['schedules']), campId);
    expect((await bulkAttestCamp(campId, STEWARD)).gapRequirementIds).toEqual(['sessions-verified']);
    const result = await recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'schedules', reason: 'Drop-in program; the office confirmed there are no sessions.' }, STEWARD);
    expect(result.dataConfidence).toBe('VERIFIED');
  });
});

describe('a session with no fixed daily time', () => {
  it('is recorded with a reason as its own kind, and satisfies the session\'s time requirement', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    const result = await recordStewardEntry(campId, { kind: 'session-no-fixed-time', scheduleId: session!.id, reason: 'Overnight camp: campers stay all week.' }, STEWARD);
    expect(result.dataConfidence).toBe('VERIFIED');
    expect((await timeClaim(session!.id))!.event).toMatchObject({ status: 'assumed', method: 'no-fixed-time' });
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: null, endTime: null });
    expect(() => parseEntry({ kind: 'session-no-fixed-time', scheduleId: session!.id })).toThrow('A reason is required');
    expect(() => parseEntry({ kind: 'session-time', scheduleId: session!.id, startTime: '9:00 PM', endTime: '7:00 AM' })).toThrow('no fixed daily time');
  });
});

describe('a cited time that would replace a value the reviewer was not shown', () => {
  const week2 = { ...weekOne(null), label: 'Week 2', startDate: '2027-06-21', endDate: '2027-06-25' };
  const cited = (old: unknown[] | null) => ({
    ...listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' }), week2], [{ excerpt: WEEK_ONE, times: [{ excerpt: DAILY }] }, { excerpt: 'Week 2: June 21 - June 25, 2027' }]),
    old,
  });

  it('keeps a steward\'s time entered after the proposal was built, says so, and still applies the rest of the list', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    const pending = cited([weekOne(null)]);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '8:00 AM', endTime: '2:00 PM' }, STEWARD);
    const result = await approveAll({ schedules: pending }, campId);
    expect(result.provenanceErrors).toEqual([expect.objectContaining({ step: 'sessionTimeKept', message: expect.stringContaining('kept 8:00 AM–2:00 PM') })]);
    const sessions = await sessionOf(campId);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.id === session!.id)).toMatchObject({ startTime: '8:00 AM', endTime: '2:00 PM' });
    expect((await timeClaim(session!.id))!.event).toMatchObject({ method: 'steward-entry' });
  });

  it('F3: keeps a steward\'s time when the proposal has no old row for the session at all', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '8:00 AM', endTime: '2:00 PM' }, STEWARD);
    const result = await approveAll({ schedules: cited(null) }, campId);
    expect(result.provenanceErrors.map((e) => e.step)).toEqual(['sessionTimeKept']);
    expect((await sessionOf(campId)).find((s) => s.id === session!.id)).toMatchObject({ startTime: '8:00 AM', endTime: '2:00 PM' });
  });

  it('M2: keeps a steward\'s "no fixed daily time"', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-no-fixed-time', scheduleId: session!.id, reason: 'Overnight camp.' }, STEWARD);
    const result = await approveAll({ schedules: cited([weekOne(null)]) }, campId);
    expect(result.provenanceErrors).toEqual([expect.objectContaining({ step: 'sessionTimeKept', message: expect.stringContaining('no fixed daily time') })]);
    expect((await sessionOf(campId)).find((s) => s.id === session!.id)).toMatchObject({ startTime: null, endTime: null });
    expect((await timeClaim(session!.id))!.event).toMatchObject({ status: 'assumed', method: 'no-fixed-time' });
  });
});

describe('the newest event decides what a session\'s time is', () => {
  it('J3b: a crawl-cited time, then a steward\'s "no fixed daily time": a later cited time is kept out', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-no-fixed-time', scheduleId: session!.id, reason: 'Varies by day.' }, STEWARD);
    const pending = listDiff([weekOne(null)], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE, times: [{ excerpt: DAILY }] }]);
    const result = await approveAll({ schedules: pending }, campId);
    expect(result.provenanceErrors.map((e) => e.step)).toEqual(['sessionTimeKept']);
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: null, endTime: null });
    expect((await timeClaim(session!.id))!.event).toMatchObject({ method: 'no-fixed-time' });
  });

  it('J3a: "no fixed daily time", then a steward time: a proposal that shows that time applies its cited time', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(NO_TIME), campId);
    const [session] = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-no-fixed-time', scheduleId: session!.id, reason: 'Varies by day.' }, STEWARD);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: session!.id, startTime: '8:00 AM', endTime: '2:00 PM' }, STEWARD);
    const pending = listDiff([weekOne({ startTime: '8:00 AM', endTime: '2:00 PM' })], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE, times: [{ excerpt: DAILY }] }]);
    const result = await approveAll({ schedules: pending }, campId);
    expect(result.provenanceErrors.map((e) => e.step)).not.toContain('sessionTimeKept');
    expect((await sessionOf(campId))[0]).toMatchObject({ startTime: '9:00 AM', endTime: '3:30 PM' });
  });

  it('two stored sessions told apart only by their times: a cited time that is neither\'s, unshown, is refused', async () => {
    const campId = await seedCamp();
    const pm = { ...weekOne({ startTime: '1:00 PM', endTime: '4:00 PM' }) };
    await approveAll(fullChanges(listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '12:00 PM' }), pm], [{ excerpt: WEEK_ONE, times: [{ excerpt: 'morning 9:00 AM - 12:00 PM' }] }, { excerpt: WEEK_ONE, times: [{ excerpt: 'afternoon 1:00 PM - 4:00 PM' }] }])), campId);
    expect(await sessionOf(campId)).toHaveLength(2);
    const pending = listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE, times: [{ excerpt: DAILY }] }]);
    await expect(approveAll({ schedules: pending }, campId)).rejects.toThrow('more than one stored session');
    expect((await sessionOf(campId)).map((s) => s.startTime).sort()).toEqual(['1:00 PM', '9:00 AM']);
  });
});

describe('an "intentionally empty" attestation', () => {
  const claimOf = (campId: string, field: string) => `camp.${campId}.field.${field}`;
  async function insertEvent(campId: string, field: string, method: string, secondsFromNow: number) {
    const pool = getTestPool();
    const claimId = claimOf(campId, field);
    const id = `${method}.${randomUUID()}`;
    await pool.query(`INSERT INTO "SurfaceEvidence" (id, "claimId", "evidenceType", method, "sourceRef", "excerptOrSummary", "observedAt", "collectedBy") VALUES ($1, $2, 'human_attestation', 'attestation', 'test', 'test', now(), 'test')`, [`ev.${id}`, claimId]);
    await pool.query(`INSERT INTO "SurfaceVerificationEvent" (id, "claimId", status, type, actor, method, "evidenceIds", "createdAt") VALUES ($1, $2, 'assumed', 'verification', 'test', $3, ARRAY[$4], now() + make_interval(secs => $5))`, [`evt.${id}`, claimId, method, `ev.${id}`, secondsFromNow]);
  }
  const pricingStatus = async (campId: string) => (await deriveCampVerification(campId)).requirements.find((r) => r.id === 'pricing')!.status;

  it('C2: does not count once the list has rows (inserted directly, as a seed or import would)', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME, ['pricing']), campId);
    await recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'pricing', reason: 'Free program.' }, STEWARD);
    expect(await pricingStatus(campId)).toBe('verified');
    await getTestPool().query(`INSERT INTO "CampPricing" (id, "campId", label, amount, unit) VALUES (gen_random_uuid()::text, $1, 'Tuition', 395, 'PER_WEEK')`, [campId]);
    expect(await pricingStatus(campId)).not.toBe('verified');
  });

  it('F6: only the NEWEST event decides: an older "intentionally empty" under a newer other attestation does not count', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME, ['pricing']), campId);
    await recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'pricing', reason: 'Free program.' }, STEWARD);
    expect(await pricingStatus(campId)).toBe('verified');
    await insertEvent(campId, 'pricing', 'attestation', 60);
    expect(await pricingStatus(campId)).not.toBe('verified');
    await insertEvent(campId, 'pricing', 'intentionally-empty', 120);
    expect(await pricingStatus(campId)).toBe('verified');
  });

  it('is refused while a pending crawl proposal lists entries for that list', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(CITED_TIME, ['pricing']), campId);
    await seedProposal(campId, { pricing: listDiff([], [{ label: 'Tuition', amount: 395, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }], [{ excerpt: 'Tuition: $395 per week' }]) });
    await expect(recordStewardEntry(campId, { kind: 'intentionally-empty', field: 'pricing', reason: 'Free program.' }, STEWARD))
      .rejects.toThrow('A pending crawl proposal lists pricing');
  });
});

describe('a session time citation not on the stored page', () => {
  it('is not attested, even when its text states the time', async () => {
    const campId = await seedCamp();
    const offPage = listDiff([], [weekOne({ startTime: '9:00 AM', endTime: '3:30 PM' })], [{ excerpt: WEEK_ONE, times: [{ excerpt: 'Hours 9:00 AM - 3:30 PM (not on this page)' }] }]);
    const result = await approveAll(fullChanges(offPage), campId);
    expect(result.verification?.dataConfidence).toBe('PLACEHOLDER');
    const [session] = await sessionOf(campId);
    expect(await timeClaim(session!.id)).toBeNull();
  });
});

describe('the guidance derivation', () => {
  it('reads the camp and every session from one derivation, with the same result as deriving each', async () => {
    const campId = await seedCamp();
    await approveAll(fullChanges(listDiff([], [weekOne(null), { ...weekOne(null), label: 'Week 2', startDate: '2027-06-21', endDate: '2027-06-25' }],
      [{ excerpt: WEEK_ONE }, { excerpt: 'Week 2: June 21 - June 25, 2027' }])), campId);
    const sessions = await sessionOf(campId);
    await recordStewardEntry(campId, { kind: 'session-time', scheduleId: sessions[0]!.id, startTime: '9:00 AM', endTime: '3:30 PM' }, STEWARD);
    const both = await deriveCampAndSessionVerification(campId);
    expect(both.camp.status).toBe((await deriveCampVerification(campId)).status);
    for (const session of sessions) {
      const single = await deriveSessionVerification(session.id);
      expect(both.sessions.get(session.id)!.requirements.map((r) => [r.id, r.status])).toEqual(single.requirements.map((r) => [r.id, r.status]));
    }
    expect(both.sessions.get(sessions[0]!.id)!.requirements.find((r) => r.id === 'time')!.status).toBe('verified');
    expect(both.sessions.get(sessions[1]!.id)!.requirements.find((r) => r.id === 'time')!.status).not.toBe('verified');
  });
});
