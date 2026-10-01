/**
 * End to end, through the real crawl pipeline, proposal write, Survey review
 * and apply: list updates wait for a complete run.
 *
 * Incomplete: the page is split into small chunks and every chunk after the
 * first fails, so Traverse reports the run partial (provider-failure). A new
 * session read from the first chunk must not become a list proposal; the
 * proposal carries only the scalar change and names the withheld list for
 * the review page, and applying it leaves every list row as it was.
 * Complete: the same camp read in one chunk proposes the full session list,
 * including the removal, and applying it gives the right rows.
 *
 * Only the network fetch and the model are stubbed: the camp is loaded by the
 * pipeline's own query, the real recrawl adapter builds the proposal, and
 * approval goes through applyProposalReview.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExtractionProvider } from '@kontourai/traverse';
import { createInMemorySnapshotStore } from '@kontourai/traverse/fetch';

import { createStubProvider, type StubProposalSpec } from '../fixtures/traverse/stub-provider';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

let specs: StubProposalSpec[] = [];
let html = '';
let failLaterChunks = true;

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => {
    const first = createStubProvider(specs, { model: 'stub-incomplete-e2e' });
    let calls = 0;
    const provider: ExtractionProvider = {
      name: first.name,
      extract: async (input) => {
        calls += 1;
        if (failLaterChunks && calls > 1) throw new Error('fixture: provider unavailable for this chunk');
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
import { storedWithheldListFields, withheldListNotice } from '@/lib/admin/proposal-extraction-status';
import type { CampChangeProposal } from '@/lib/admin/types';
import { campLogOutcomeNote } from '@/app/admin/crawls/camp-log-view';

const REVIEWER = 'reviewer@campfit.test';
const CAMP_NAME = 'Mountain Explorers Day Camp';

async function seedCamp(opts: { ageGroups?: boolean } = {}): Promise<string> {
  const pool = getTestPool();
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl", "communitySlug")
     VALUES ('incomplete-e2e-camp', $1, 'SUMMER_DAY', 'SPORTS', '', 'Boulder', 'https://incomplete-e2e.example.test/camp', 'denver') RETURNING id`,
    [CAMP_NAME],
  );
  const campId = camp.rows[0]!.id;
  await pool.query(
    `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff")
     VALUES ('live-week-1', $1, 'Week 1: Nature 2027', '2027-06-07', '2027-06-11', '09:00', '15:00', NULL),
            ('live-week-2', $1, 'Week 2: Rivers 2027', '2027-06-14', '2027-06-18', '09:00', '15:00', '08:00')`,
    [campId],
  );
  await pool.query(
    `INSERT INTO "CampPricing" (id, "campId", label, amount, unit, "durationWeeks", "ageQualifier", "discountNotes")
     VALUES ('live-price', $1, 'Standard week', 425, 'PER_WEEK', 1, 'ages 6-9', 'Sibling discount 10%')`,
    [campId],
  );
  if (opts.ageGroups !== false) {
    await pool.query(
      `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
       VALUES ('live-ages', $1, 'Ages 6-9', 6, 9, 1, 3)`,
      [campId],
    );
  }
  return campId;
}

function page(lines: string[]): string {
  const filler = 'More sessions, rates and aftercare details follow on this page. '.repeat(60);
  return `<html><body><main><h1>${CAMP_NAME}</h1>${lines.map((line) => `<p>${line}</p>`).join('')}<p>${filler}</p></main></body></html>`;
}

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

async function approveAll(proposal: CampChangeProposal) {
  const session = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
  const events = buildReviewSessionEvents({
    ...(session.snapshot as ReviewQueueSessionState),
    decisionsByItemName: Object.fromEntries(session.snapshot.items.map((item) => [item.metadata.name, 'accept-proposed' as const])),
  });
  await replaceSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId: session.id, proposal, events, actorEmail: REVIEWER });
  return applyProposalReview({ proposalId: proposal.id, reviewSessionId: session.id, reviewer: REVIEWER, keepPending: false });
}

const SESSION_SPECS: StubProposalSpec[] = [
  { fieldPath: 'items[0].name', candidateValue: CAMP_NAME, needle: CAMP_NAME },
  { fieldPath: 'items[0].schedules[0].startDate', candidateValue: '2027-06-07', needle: 'Week 1: Nature 2027' },
  { fieldPath: 'items[0].schedules[0].endDate', candidateValue: '2027-06-11', needle: 'Week 1: Nature 2027' },
  { fieldPath: 'items[0].schedules[1].startDate', candidateValue: '2027-06-21', needle: 'Week 3: Peaks 2027' },
  { fieldPath: 'items[0].schedules[1].endDate', candidateValue: '2027-06-25', needle: 'Week 3: Peaks 2027' },
];

const previousChunkSize = process.env.TRAVERSE_CHUNK_SIZE;
beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  if (previousChunkSize === undefined) delete process.env.TRAVERSE_CHUNK_SIZE;
  else process.env.TRAVERSE_CHUNK_SIZE = previousChunkSize;
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "CrawlRun" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('list updates wait for a complete run, end to end', () => {
  it('an incomplete run proposes no list change, names the withheld list for review, and applying leaves the rows unchanged', async () => {
    process.env.TRAVERSE_CHUNK_SIZE = '1000';
    failLaterChunks = true;
    const campId = await seedCamp();
    specs = [...SESSION_SPECS, { fieldPath: 'items[0].city', candidateValue: 'Denver', needle: 'Denver, Colorado' }];
    html = page(['Denver, Colorado', 'Week 1: Nature 2027 June 7-11', 'Week 3: Peaks 2027 June 21-25']);

    const { entry, proposalIds } = await crawl(campId);
    expect(entry.incomplete?.reason).toBe('provider-failure');
    expect(entry.warnings?.some((w) => w.startsWith('schedules change withheld'))).toBe(true);
    expect(entry.incomplete?.withheldListFields).toEqual(['schedules']);
    expect(campLogOutcomeNote(entry)).toContain('List updates for sessions were withheld');
    expect(proposalIds).toHaveLength(1);
    const proposal = (await getProposal(proposalIds[0]!))!;
    expect(Object.keys(proposal.proposedChanges)).toEqual(['city']);
    expect(storedWithheldListFields(proposal.rawExtraction)).toEqual(['schedules']);
    expect(withheldListNotice('schedules')).toContain('List updates for sessions were withheld');

    await approveAll(proposal);
    expect(await counts(campId)).toEqual({ sessions: 2, prices: 1, ageGroups: 1 });
    const pool = getTestPool();
    expect((await pool.query(`SELECT city FROM "Camp" WHERE id = $1`, [campId])).rows[0]).toEqual({ city: 'Denver' });
  });

  it('an incomplete run that fills an empty list keeps it and records it as possibly partial', async () => {
    process.env.TRAVERSE_CHUNK_SIZE = '1000';
    failLaterChunks = true;
    const campId = await seedCamp({ ageGroups: false });
    specs = [
      { fieldPath: 'items[0].name', candidateValue: CAMP_NAME, needle: CAMP_NAME },
      { fieldPath: 'items[0].ageGroups[0].minAge', candidateValue: 6, needle: 'Ages 6-9' },
      { fieldPath: 'items[0].ageGroups[0].maxAge', candidateValue: 9, needle: 'Ages 6-9' },
    ];
    html = page(['Ages 6-9']);

    const { entry, proposalIds } = await crawl(campId);
    expect(entry.incomplete?.reason).toBe('provider-failure');
    expect(entry.incomplete?.populatedListFields).toEqual(['ageGroups']);
    expect(entry.incomplete?.withheldListFields).toBeUndefined();
    expect(proposalIds).toHaveLength(1);
    const proposal = (await getProposal(proposalIds[0]!))!;
    expect(proposal.proposedChanges.ageGroups?.mode).toBe('populate');
    expect(proposal.rawExtraction.populatedListFields).toEqual(['ageGroups']);
  });

  it('a complete run proposes the full list, including the removal, and applying it gives the right rows', async () => {
    delete process.env.TRAVERSE_CHUNK_SIZE;
    failLaterChunks = true;
    const campId = await seedCamp();
    specs = SESSION_SPECS;
    html = page(['Week 1: Nature 2027 June 7-11', 'Week 3: Peaks 2027 June 21-25']);

    const { entry, proposalIds } = await crawl(campId);
    expect(entry.incomplete).toBeUndefined();
    expect(proposalIds).toHaveLength(1);
    const proposal = (await getProposal(proposalIds[0]!))!;
    expect(proposal.proposedChanges.schedules?.mode).toBe('update');
    expect(storedWithheldListFields(proposal.rawExtraction)).toEqual([]);

    await approveAll(proposal);
    // Week 1 kept (matched by label + dates), Week 2 archived, Week 3 created.
    expect(await counts(campId)).toEqual({ sessions: 2, prices: 1, ageGroups: 1 });
    const pool = getTestPool();
    const rows = await pool.query<{ id: string; label: string; archived: boolean }>(
      `SELECT id, label, "archivedAt" IS NOT NULL AS archived FROM "CampSchedule" WHERE "campId" = $1 ORDER BY "startDate"`, [campId],
    );
    expect(rows.rows.map((row) => [row.label, row.archived])).toEqual([
      ['Week 1: Nature 2027', false], ['Week 2: Rivers 2027', true], ['Week 3: Peaks 2027', false],
    ]);
    expect(rows.rows[0]!.id).toBe('live-week-1');
  });
});
