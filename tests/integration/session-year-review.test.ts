/**
 * A session whose dates take their year from another excerpt on the page
 * (session-year.ts), through the real review-apply path against a throwaway
 * Postgres: the dates are attested only when that excerpt is on the stored
 * page and states exactly the dates' one year. The stored snapshot is real;
 * only its store is in memory.
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
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import type { FieldDiff, ProposedChanges } from '@/lib/admin/types';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const REVIEWER = 'reviewer@campfit.test';
const URL = 'https://larkspur.example.test/summer';
const HEADING = '## 2027 Camp Dates';
const WEEK_ONE = 'Week 1: June 14 - June 18';
const WEEK_SIX = 'Week 6: July 19 - 23 (2026-27)';

/** The stored page. Every excerpt below is one of its lines, verbatim and unique. */
const PAGE = [
  'Larkspur Meadow is a week-long outdoor science day camp.',
  'Our 2026 season in photos',
  HEADING,
  WEEK_ONE,
  'Camp runs 9:00 AM - 3:30 PM every day.',
  'Dates for 2026 and 2027 are below.',
  'Winter week: December 28, 2026 - January 3, 2027',
  WEEK_SIX,
].join('\n');

const ROW = { label: 'Week 1', startDate: '2027-06-14', endDate: '2027-06-18', startTime: null, endTime: null, earlyDropOff: null, latePickup: null };

function schedules(citation: NonNullable<FieldDiff['rowCitations']>[number]): ProposedChanges {
  return { schedules: { old: [], new: [ROW], confidence: 0.9, excerpt: WEEK_ONE, sourceUrl: URL, mode: 'add_items', rowCitations: [citation] } };
}

async function seedCamp(): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl")
     VALUES ($1, 'Larkspur Meadow', 'SLEEPAWAY', 'SPORTS', '', '', $2) RETURNING id`,
    [`larkspur-${randomUUID()}`, URL],
  );
  return rows[0]!.id;
}

async function approveAll(changes: ProposedChanges, campId: string) {
  const bodyHash = sha256Hex(PAGE);
  const snapshot = { sourceId: `camp-${campId}`, url: URL, fetchedAt: '2026-09-30T12:00:00.000Z', status: 200, contentType: 'text' as const, body: PAGE, bodyHash, headers: {} };
  fixture.store ??= createInMemorySnapshotStore();
  await (fixture.store as SnapshotStore).put(snapshot as never);
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status, "snapshotRef", "snapshotBodyHash", "rawExtraction")
     VALUES ($1, $2, $3::jsonb, 0.9, 'test-extraction-model', 'PENDING', $4, $5, '{}'::jsonb) RETURNING id`,
    [campId, URL, JSON.stringify(changes), buildSnapshotSourceRef(snapshot as never), bodyHash],
  );
  const proposal = (await getProposal(rows[0]!.id))!;
  const reviewSession = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
  const events = buildReviewSessionEvents({
    ...(reviewSession.snapshot as ReviewQueueSessionState),
    decisionsByItemName: Object.fromEntries(reviewSession.snapshot.items.map((item) => [item.metadata.name, 'accept-proposed' as const])),
  });
  await replaceSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId: reviewSession.id, proposal, events, actorEmail: REVIEWER });
  return applyProposalReview({ proposalId: proposal.id, reviewSessionId: reviewSession.id, reviewer: REVIEWER, keepPending: false });
}

/** The evidence the session's dates claim's newest event cites. */
async function datesEvidence(campId: string) {
  const pool = getTestPool();
  const { rows: sessions } = await pool.query<{ id: string }>(`SELECT id FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`, [campId]);
  const event = (await pool.query<{ evidenceIds: string[] }>(
    `SELECT "evidenceIds" FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [`session.${sessions[0]!.id}.dates`])).rows[0]!;
  return (await pool.query<{ excerptOrSummary: string; sourceLocator: string | null; metadata: Record<string, unknown> }>(
    `SELECT "excerptOrSummary", "sourceLocator", metadata FROM "SurfaceEvidence" WHERE id = ANY($1::text[])`, [event.evidenceIds])).rows;
}

/** The session's dates claim: its newest event's status, or null when none. */
async function datesClaim(campId: string): Promise<string | null> {
  const pool = getTestPool();
  const { rows: sessions } = await pool.query<{ id: string; startDate: string }>(
    `SELECT id, to_char("startDate", 'YYYY-MM-DD') AS "startDate" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`, [campId]);
  // The apply writes the session whatever its citation; only the attestation depends on it.
  expect(sessions.map((s) => s.startDate)).toEqual(['2027-06-14']);
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [`session.${sessions[0]!.id}.dates`]);
  return rows[0]?.status ?? null;
}

beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  fixture.store = null;
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('a session whose year comes from another excerpt', () => {
  it('is attested when the year excerpt is on the stored page and states the dates\' year', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE, year: { excerpt: HEADING } }), campId);
    expect(await datesClaim(campId)).toBe('verified');
  });

  it('records the year excerpt and its locator on the verified dates claim\'s evidence', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE, year: { excerpt: HEADING } }), campId);
    const start = PAGE.indexOf(HEADING);
    const evidence = await datesEvidence(campId);
    expect(evidence.some((e) => e.metadata.yearExcerpt === HEADING && e.metadata.yearLocator === `chars:${start}-${start + HEADING.length}`)).toBe(true);
  });

  it('is not attested when the year excerpt is not on the stored page', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE, year: { excerpt: '2027 Summer Sessions' } }), campId);
    expect(await datesClaim(campId)).not.toBe('verified');
  });

  it('is not attested when the year excerpt is on the page but states another year', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE, year: { excerpt: 'Our 2026 season in photos' } }), campId);
    expect(await datesClaim(campId)).not.toBe('verified');
  });

  it('is not attested when the year excerpt states more than one year', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE, year: { excerpt: 'Dates for 2026 and 2027 are below.' } }), campId);
    expect(await datesClaim(campId)).not.toBe('verified');
  });

  it('is not attested when the year excerpt\'s locator points elsewhere', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE, year: { excerpt: HEADING, locator: 'chars:0-15' } }), campId);
    expect(await datesClaim(campId)).not.toBe('verified');
  });

  it('a row with no year citation whose citation was stretched up to the heading is not attested (a proposal from before)', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: `${HEADING}\n${WEEK_ONE}` }), campId);
    expect(await datesClaim(campId)).not.toBe('verified');
  });

  it('control: a row with no year citation and an unstretched citation is attested as before', async () => {
    const campId = await seedCamp();
    await approveAll(schedules({ excerpt: WEEK_ONE }), campId);
    expect(await datesClaim(campId)).toBe('verified');
  });

  it('fix round 5: a multi-year line with no year citation binds each date to its own year at apply', async () => {
    const winter = 'Winter week: December 28, 2026 - January 3, 2027';
    const wrong = { ...ROW, label: 'Winter week', startDate: '2027-12-28', endDate: '2028-01-03' };
    const campId = await seedCamp();
    await approveAll({ schedules: { old: [], new: [wrong], confidence: 0.9, excerpt: winter, sourceUrl: URL, mode: 'add_items', rowCitations: [{ excerpt: winter }] } }, campId);
    expect(await datesClaimOf(campId)).not.toBe('verified');
  });

  it('fix round 5: control: the right pairing on that line is attested at apply', async () => {
    const winter = 'Winter week: December 28, 2026 - January 3, 2027';
    const right = { ...ROW, label: 'Winter week', startDate: '2026-12-28', endDate: '2027-01-03' };
    const campId = await seedCamp();
    await approveAll({ schedules: { old: [], new: [right], confidence: 0.9, excerpt: winter, sourceUrl: URL, mode: 'add_items', rowCitations: [{ excerpt: winter }] } }, campId);
    expect(await datesClaimOf(campId)).toBe('verified');
  });

  it('fix round 6: a session that ends before it starts is refused at apply, and nothing is written', async () => {
    const winter = 'Winter week: December 28, 2026 - January 3, 2027';
    const reversed = { ...ROW, label: 'Winter week', startDate: '2026-12-28', endDate: '2026-01-03' };
    const campId = await seedCamp();
    await expect(approveAll({ schedules: { old: [], new: [reversed], confidence: 0.9, excerpt: winter, sourceUrl: URL, mode: 'add_items', rowCitations: [{ excerpt: winter }] } }, campId))
      .rejects.toThrow(/ends before it starts/);
    const { rows } = await getTestPool().query(`SELECT id FROM "CampSchedule" WHERE "campId" = $1`, [campId]);
    expect(rows).toEqual([]);
  });

  it('fix round 6: a row with a year citation whose own date line states two years is not attested', async () => {
    const campId = await seedCamp();
    const row = { ...ROW, label: 'Week 6', startDate: '2027-07-19', endDate: '2027-07-23' };
    await approveAll({ schedules: { old: [], new: [row], confidence: 0.9, excerpt: WEEK_SIX, sourceUrl: URL, mode: 'add_items', rowCitations: [{ excerpt: WEEK_SIX, year: { excerpt: HEADING } }] } }, campId);
    expect(await datesClaimOf(campId)).not.toBe('verified');
  });
});

/** The only session's dates claim status, whatever its dates. */
async function datesClaimOf(campId: string): Promise<string | null> {
  const pool = getTestPool();
  const { rows: sessions } = await pool.query<{ id: string }>(`SELECT id FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`, [campId]);
  expect(sessions).toHaveLength(1);
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [`session.${sessions[0]!.id}.dates`]);
  return rows[0]?.status ?? null;
}
