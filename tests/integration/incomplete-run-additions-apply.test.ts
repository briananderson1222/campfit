/**
 * End to end: an incomplete recrawl of a camp whose live lists carry fields
 * the extraction never fills (session times, discount notes, grades), run
 * through the real crawl pipeline, proposal write, Survey review and apply.
 *
 * The page is split into small chunks and every chunk after the first fails,
 * so Traverse reports the run partial (provider-failure). Only the network
 * fetch and the model are stubbed: the camp is loaded by the pipeline's own
 * query, the real recrawl adapter builds the proposal, and approval goes
 * through applyProposalReview (session reconciliation, relation re-insert).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionProvider } from '@kontourai/traverse';
import { createInMemorySnapshotStore } from '@kontourai/traverse/fetch';

import { createStubProvider, type StubProposalSpec } from '../fixtures/traverse/stub-provider';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

let specs: StubProposalSpec[] = [];
let html = '';

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => {
    const first = createStubProvider(specs, { model: 'stub-incomplete-e2e' });
    let calls = 0;
    const provider: ExtractionProvider = {
      name: first.name,
      extract: async (input) => {
        calls += 1;
        if (calls > 1) throw new Error('fixture: provider unavailable for this chunk');
        return first.extract(input);
      },
    };
    return { provider, ref: 'stub', datumProvider: 'stub', model: 'stub-incomplete-e2e', maxTokens: 2048 };
  },
}));

// One store for the crawl and the apply path's snapshot check.
const snapshotStore = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/ingestion/traverse-snapshot-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ingestion/traverse-snapshot-store')>()),
  createCampfitSnapshotStore: () => (snapshotStore.current ??= createInMemorySnapshotStore()),
}));

// The real adapter, with the page served by the egress fixture oracle instead
// of the network.
vi.mock('@/lib/ingestion/traverse-recrawl-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/traverse-recrawl-adapter')>();
  return {
    ...actual,
    runTraverseRecrawlForCamp: (options: Parameters<typeof actual.runTraverseRecrawlForCamp>[0]) =>
      actual.runTraverseRecrawlForCamp({
        ...options,
        fetchOptions: {
          sleep: async () => {},
          egressResolver: async () => [{ address: '93.184.216.34', family: 4 }],
          egressResponseOracle: {
            responses: [
              { urlSuffix: '/robots.txt', body: 'User-agent: *\nDisallow:', headers: { 'content-type': 'text/plain' }, repeat: true },
              { body: html, headers: { 'content-type': 'text/html; charset=utf-8' }, repeat: true },
            ],
          },
        } as never,
      }),
  };
});

import { buildReviewSessionEvents, type ReviewQueueSessionState } from '@kontourai/survey/review-workbench';
import { getPool as getProductionPool } from '@/lib/db';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { applyProposalReview } from '@/lib/admin/review-apply';
import { getProposal } from '@/lib/admin/review-repository';
import { getCrawlRun } from '@/lib/admin/crawl-repository';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';

const REVIEWER = 'reviewer@campfit.test';
const CAMP_NAME = 'Mountain Explorers Day Camp';

async function seedCamp(): Promise<string> {
  const pool = getTestPool();
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl", "communitySlug")
     VALUES ('incomplete-e2e-camp', $1, 'SUMMER_DAY', 'SPORTS', '', 'Boulder', 'https://incomplete-e2e.example.test/camp', 'denver') RETURNING id`,
    [CAMP_NAME],
  );
  const campId = camp.rows[0]!.id;
  await pool.query(
    `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff")
     VALUES ('live-week-1', $1, 'Week 1: Nature', '2027-06-07', '2027-06-11', '09:00', '15:00', NULL),
            ('live-week-2', $1, 'Week 2: Rivers', '2027-06-14', '2027-06-18', '09:00', '15:00', '08:00')`,
    [campId],
  );
  await pool.query(
    `INSERT INTO "CampPricing" (id, "campId", label, amount, unit, "durationWeeks", "ageQualifier", "discountNotes")
     VALUES ('live-price', $1, 'Standard week', 425, 'PER_WEEK', 1, 'ages 6-9', 'Sibling discount 10%')`,
    [campId],
  );
  await pool.query(
    `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
     VALUES ('live-ages', $1, 'Ages 6-9', 6, 9, 1, 3)`,
    [campId],
  );
  return campId;
}

function page(lines: string[]): string {
  const filler = 'More sessions, rates and aftercare details follow on this page. '.repeat(60);
  return `<html><body><main><h1>${CAMP_NAME}</h1>${lines.map((line) => `<p>${line}</p>`).join('')}<p>${filler}</p></main></body></html>`;
}

// What the model reads from the first chunk: the live entries with different
// capitalization, and none of times/discount notes/grades.
const LIVE_READ: StubProposalSpec[] = [
  { fieldPath: 'items[0].name', candidateValue: CAMP_NAME, needle: CAMP_NAME },
  { fieldPath: 'items[0].schedules[0].startDate', candidateValue: '2027-06-07', needle: 'WEEK 1: NATURE' },
  { fieldPath: 'items[0].schedules[0].endDate', candidateValue: '2027-06-11', needle: 'WEEK 1: NATURE' },
  { fieldPath: 'items[0].pricing[0].amount', candidateValue: 425, needle: 'STANDARD WEEK' },
  { fieldPath: 'items[0].pricing[0].unit', candidateValue: 'PER_WEEK', needle: 'STANDARD WEEK' },
  { fieldPath: 'items[0].ageGroups[0].minAge', candidateValue: 6, needle: 'ages 6-9' },
  { fieldPath: 'items[0].ageGroups[0].maxAge', candidateValue: 9, needle: 'ages 6-9' },
];

async function crawl(campId: string) {
  const run = await runCrawlPipeline({ triggeredBy: 'test:incomplete-e2e', trigger: 'MANUAL', campIds: [campId], concurrency: 1 });
  const entry = (await getCrawlRun(run.id))!.campLog.find((e) => e.campId === campId)!;
  const proposals = await getTestPool().query<{ id: string }>(`SELECT id FROM "CampChangeProposal" WHERE "campId" = $1`, [campId]);
  return { entry, proposalIds: proposals.rows.map((row) => row.id) };
}

async function counts(campId: string) {
  const pool = getTestPool();
  const one = async (sql: string) => Number((await pool.query<{ n: string }>(sql, [campId])).rows[0]!.n);
  return {
    sessions: await one(`SELECT count(*) AS n FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`),
    prices: await one(`SELECT count(*) AS n FROM "CampPricing" WHERE "campId" = $1`),
    ageGroups: await one(`SELECT count(*) AS n FROM "CampAgeGroup" WHERE "campId" = $1`),
  };
}

const previousChunkSize = process.env.TRAVERSE_CHUNK_SIZE;
beforeAll(async () => { await assertTestDatabase(); });
beforeEach(() => { process.env.TRAVERSE_CHUNK_SIZE = '1000'; });
afterEach(async () => {
  if (previousChunkSize === undefined) delete process.env.TRAVERSE_CHUNK_SIZE;
  else process.env.TRAVERSE_CHUNK_SIZE = previousChunkSize;
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "CrawlRun" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('incomplete recrawl, additions only, end to end', () => {
  it('reading only existing entries (blanked fields, other capitalization) proposes nothing', async () => {
    const campId = await seedCamp();
    specs = LIVE_READ;
    html = page(['WEEK 1: NATURE June 7-11', 'STANDARD WEEK $425', 'ages 6-9']);

    const { entry, proposalIds } = await crawl(campId);

    expect(entry.incomplete?.reason).toBe('provider-failure');
    expect(entry.status).toBe('no_changes');
    expect(proposalIds).toEqual([]);
    expect(await counts(campId)).toEqual({ sessions: 2, prices: 1, ageGroups: 1 });
  });

  it('a new session and a new price are added on approval, and nothing is duplicated or removed', async () => {
    const campId = await seedCamp();
    specs = [
      ...LIVE_READ,
      { fieldPath: 'items[0].schedules[1].startDate', candidateValue: '2027-06-21', needle: 'Week 3: Peaks' },
      { fieldPath: 'items[0].schedules[1].endDate', candidateValue: '2027-06-25', needle: 'Week 3: Peaks' },
      { fieldPath: 'items[0].pricing[1].amount', candidateValue: 395, needle: 'Early bird' },
      { fieldPath: 'items[0].pricing[1].unit', candidateValue: 'PER_WEEK', needle: 'Early bird' },
    ];
    html = page(['WEEK 1: NATURE June 7-11', 'Week 3: Peaks June 21-25', 'STANDARD WEEK $425', 'Early bird $395', 'ages 6-9']);

    const { entry, proposalIds } = await crawl(campId);
    expect(entry.incomplete?.reason).toBe('provider-failure');
    expect(proposalIds).toHaveLength(1);
    const proposal = (await getProposal(proposalIds[0]!))!;
    expect(Object.keys(proposal.proposedChanges).sort()).toEqual(['pricing', 'schedules']);
    expect(proposal.proposedChanges.schedules!.mode).toBe('add_items');
    expect((proposal.proposedChanges.schedules!.new as unknown[]).length).toBe(3);
    expect((proposal.proposedChanges.pricing!.new as unknown[]).length).toBe(2);

    const session = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
    const events = buildReviewSessionEvents({
      ...(session.snapshot as ReviewQueueSessionState),
      decisionsByItemName: Object.fromEntries(session.snapshot.items.map((item) => [item.metadata.name, 'accept-proposed' as const])),
    });
    await replaceSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId: session.id, proposal, events, actorEmail: REVIEWER });
    const applied = await applyProposalReview({ proposalId: proposal.id, reviewSessionId: session.id, reviewer: REVIEWER, keepPending: false });
    expect(applied.appliedFields.slice().sort()).toEqual(['pricing', 'schedules']);

    expect(await counts(campId)).toEqual({ sessions: 3, prices: 2, ageGroups: 1 });
    const pool = getTestPool();
    const sessions = await pool.query<{ id: string; startTime: string | null; earlyDropOff: string | null }>(
      `SELECT id, "startTime", "earlyDropOff" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL AND id LIKE 'live-%' ORDER BY id`,
      [campId],
    );
    // Live sessions kept their ids and their times.
    expect(sessions.rows).toEqual([
      { id: 'live-week-1', startTime: '09:00', earlyDropOff: null },
      { id: 'live-week-2', startTime: '09:00', earlyDropOff: '08:00' },
    ]);
    const prices = await pool.query<{ label: string; discountNotes: string | null }>(
      `SELECT label, "discountNotes" FROM "CampPricing" WHERE "campId" = $1 ORDER BY amount`, [campId],
    );
    expect(prices.rows).toEqual([
      { label: 'Early bird', discountNotes: null },
      { label: 'Standard week', discountNotes: 'Sibling discount 10%' },
    ]);
  });
});
