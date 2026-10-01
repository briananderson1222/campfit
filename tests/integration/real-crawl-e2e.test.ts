/**
 * A real crawl, end to end, in the shape a live run produced: the crawl
 * pipeline the cron calls, the real Relay extraction provider (only the model
 * runtime replays a recorded answer), the real recrawl adapter, proposal write,
 * Survey review and apply against a throwaway Postgres.
 *
 * Each block is one defect a live crawl exposed. The page, the model answer and
 * the request noise come from tests/fixtures/real-crawl.
 */
import os from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInMemorySnapshotStore, parseSnapshotSourceRef, type SnapshotStore } from '@kontourai/traverse/fetch';
import type { ExtractionProvider } from '@kontourai/traverse';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';
import { createReplayProvider, listingHtml, loadModelOutput, type ReplayRuntime } from '../fixtures/real-crawl/replay';

const fixture = vi.hoisted(() => ({
  proposals: [] as unknown[],
  html: '',
  /** Every model request of the current test, across runs. */
  runtimes: [] as { requests: unknown[] }[],
  providerFails: false,
  /** Every provider call after the first fails: a multi-chunk page is read only in part. */
  failAfterFirstCall: false,
  /** Model the replay runtime reports; part of the provider's identity. */
  model: 'gpt-6.1-sol',
  /** Extra oracle responses tried before the default 200. */
  responses: [] as Record<string, unknown>[],
  store: null as unknown,
}));

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => {
    const { provider, runtime } = createReplayProvider(fixture.proposals, fixture.model);
    fixture.runtimes.push(runtime as ReplayRuntime);
    let calls = 0;
    const failing: ExtractionProvider = {
      ...provider,
      extract: async (input) => {
        calls += 1;
        if (fixture.providerFails || (fixture.failAfterFirstCall && calls > 1)) throw new Error('fixture: provider unavailable');
        return provider.extract(input);
      },
    };
    return { provider: fixture.providerFails || fixture.failAfterFirstCall ? failing : provider, ref: 'replay', datumProvider: 'codex', model: 'gpt-6.1-sol', maxTokens: 2048 };
  },
}));

// One store for the crawl and for the apply path's citation check.
vi.mock('@/lib/ingestion/traverse-snapshot-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ingestion/traverse-snapshot-store')>()),
  createCampfitSnapshotStore: () => (fixture.store ??= createInMemorySnapshotStore()),
}));

// The real adapter; the page is served by the egress fixture oracle.
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
              ...fixture.responses,
              { body: fixture.html, headers: { 'content-type': 'text/html; charset=utf-8' }, repeat: true },
            ],
          },
        } as never,
      }),
  };
});

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));
vi.mock('@/lib/admin/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/access')>()),
  requireAdminAccess: requireAdminAccessMock,
}));

import { buildReviewSessionEvents, type ReviewQueueSessionState } from '@kontourai/survey/review-workbench';
import { getPool as getProductionPool } from '@/lib/db';
import { runCrawlPipeline, skipEligibleFingerprint } from '@/lib/ingestion/crawl-pipeline';
import { SNAPSHOT_STORE_ROOT } from '@/lib/ingestion/traverse-snapshot-store';
import {
  applyBatchAcceptedClaims,
  applyProposalReview,
  ReviewApplyCitationError,
  ReviewApplyValueError,
} from '@/lib/admin/review-apply';
import { createProposal, getCampProposalHistoryBatch, getProposal, updateProposalStatus } from '@/lib/admin/review-repository';
import { CrawlSchemaOutdatedError, failStaleCrawlRuns, getCrawlRun } from '@/lib/admin/crawl-repository';
import { resolveCrawlCandidates } from '@/lib/admin/crawl-priority';
import { replaceSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';
import { loadCampTrustDisplays } from '@/lib/admin/trust-display-read';
import { loadClaimBundle } from '@/lib/admin/claim-store';
import { resolveCitationText } from '@/lib/admin/citation-text';
import { resolveReviewExcerpt } from '@/lib/admin/review-excerpt-resolution';
import { storedMultiProgram, storedRefusedValues } from '@/lib/admin/proposal-extraction-status';
import { campLogModelLine, campLogOutcomeNote } from '@/app/admin/crawls/camp-log-view';
import { campfitVocabulary } from '@/lib/trust-vocabulary';
import type { CampChangeProposal } from '@/lib/admin/types';
import { POST as approveRoute } from '@/app/api/admin/review/[id]/approve/route';
import { POST as recrawlRoute } from '@/app/api/admin/camps/[campId]/crawl/route';
import { GET as cronRoute } from '@/app/api/cron/crawl/route';

const REVIEWER = 'reviewer@campfit.test';
const CAMP_NAME = 'Pine Ridge Camps';
const CAMP_URL = 'https://pineridge.example.test/dates-rates';
const recorded = loadModelOutput();

async function seedCamp(slug = 'pine-ridge-camps', name = CAMP_NAME): Promise<string> {
  const camp = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, neighborhood, "websiteUrl", "communitySlug", "registrationStatus")
     VALUES ($1, $2, 'SLEEPAWAY', 'NATURE', 'Ranch camps in the mountains.', 'Florissant', 'Teller County', $3, 'denver', 'OPEN') RETURNING id`,
    [slug, name, CAMP_URL],
  );
  return camp.rows[0]!.id;
}

async function seedRun(): Promise<string> {
  const run = await getTestPool().query<{ id: string }>(
    `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "totalCamps", status, "completedAt") VALUES ('test:real-crawl', 'MANUAL', 1, 'COMPLETED', now()) RETURNING id`,
  );
  return run.rows[0]!.id;
}

async function crawl(campIds: string[], options: Partial<Parameters<typeof runCrawlPipeline>[0]> = {}) {
  const run = await runCrawlPipeline({ triggeredBy: 'test:real-crawl', trigger: 'SCHEDULED', campIds, concurrency: 1, ...options });
  const stored = (await getCrawlRun(run.id))!;
  return { run, stored, entry: (campId: string) => stored.campLog.find((e) => e.campId === campId)! };
}

async function proposalsFor(campId: string): Promise<CampChangeProposal[]> {
  const rows = await getTestPool().query<{ id: string }>(`SELECT id FROM "CampChangeProposal" WHERE "campId" = $1 ORDER BY "createdAt"`, [campId]);
  return Promise.all(rows.rows.map(async (row) => (await getProposal(row.id))!));
}

async function openSession(proposal: CampChangeProposal) {
  const session = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
  const events = buildReviewSessionEvents({
    ...(session.snapshot as ReviewQueueSessionState),
    decisionsByItemName: Object.fromEntries(session.snapshot.items.map((item) => [item.metadata.name, 'accept-proposed' as const])),
  });
  await replaceSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId: session.id, proposal, events, actorEmail: REVIEWER });
  return session;
}

async function approveAll(proposal: CampChangeProposal) {
  const session = await openSession(proposal);
  return applyProposalReview({ proposalId: proposal.id, reviewSessionId: session.id, reviewer: REVIEWER, keepPending: false });
}

async function campRow(campId: string) {
  const { rows } = await getTestPool().query(
    `SELECT name, "applicationUrl", "campTypes", "registrationStatus", "lastCrawledAt", "lastCrawlAttemptAt", "lastVerifiedAt",
            "dataConfidence", "lastExtractedContentDigest" FROM "Camp" WHERE id = $1`,
    [campId],
  );
  return rows[0]!;
}

async function listRows(campId: string) {
  const pool = getTestPool();
  const sessions = await pool.query(`SELECT "startDate"::text AS start, "endDate"::text AS "end" FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY "startDate", "endDate"`, [campId]);
  const prices = await pool.query(`SELECT amount::float AS amount, unit FROM "CampPricing" WHERE "campId" = $1 ORDER BY amount`, [campId]);
  const ages = await pool.query(`SELECT "minAge", "maxAge" FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge"`, [campId]);
  return { sessions: sessions.rows, prices: prices.rows, ages: ages.rows };
}

function modelRequests(): number {
  return fixture.runtimes.reduce((sum, runtime) => sum + runtime.requests.length, 0);
}

beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  fixture.proposals = [];
  fixture.html = '';
  fixture.runtimes = [];
  fixture.providerFails = false;
  fixture.failAfterFirstCall = false;
  fixture.model = 'gpt-6.1-sol';
  vi.useRealTimers();
  fixture.responses = [];
  fixture.store = null;
  requireAdminAccessMock.mockReset();
  const pool = getTestPool();
  await pool.query(`DROP TRIGGER IF EXISTS block_proposal_insert ON "CampChangeProposal"`);
  await pool.query(`ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "lastCrawlAttemptAt" TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS "lastExtractedContentDigest" TEXT`);
  await pool.query(`UPDATE "CrawlSchedule" SET enabled = false`);
  delete process.env.TRAVERSE_CHUNK_SIZE;
  delete process.env.CRON_SECRET;
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  // A crawl links the camp to a provider it creates; other suites count providers.
  await pool.query(`TRUNCATE "Provider" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "CrawlRun" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('a crawl of a multi-program listing page produces a reviewable, applicable proposal', () => {
  it('extracts through the real provider, withholds the rename, and applies list fields with exact citations', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();

    const { run, entry } = await crawl([campId]);
    expect(run.status).toBe('COMPLETED');
    expect(entry(campId).status).toBe('ok');
    // Model identity and coverage are recorded for every extraction.
    expect(entry(campId).modelSource).toBe('configured');
    expect(entry(campId).coverage).toEqual({ ranges: 1, complete: 1, unread: 0, outputTruncated: 0 });
    expect(campLogModelLine(entry(campId))).toBe('Model: traverse:gpt-6.1-sol (configured id; the provider did not report one) · read 1 of 1 text range(s)');

    const [proposal] = await proposalsFor(campId);
    expect(Object.keys(proposal!.proposedChanges).sort()).toEqual(['ageGroups', 'applicationUrl', 'pricing', 'schedules']);

    // Three programs, un-indexed: no one program's name becomes the camp's.
    expect(proposal!.proposedChanges.name).toBeUndefined();
    // What assembly left out reaches the stored proposal, for the review page.
    expect(proposal!.rawExtraction.droppedEntries).toEqual([
      'schedules: "**First Session:** June 6th - July 6th, 2027" was left out because it has the same values as "**First Session:** June 6 - July 6th, 2027"',
    ]);
    expect(storedMultiProgram(proposal!.rawExtraction)).toEqual({
      names: ['Pine Ridge Junior Camp', 'High Meadow Ranch for Girls', 'Big Creek Ranch for Boys'],
      withheldFields: ['name'],
    });
    expect(entry(campId).warnings?.some((w) => w.startsWith('page lists 3 programs'))).toBe(true);
    expect(proposal!.rawExtraction.modelSource).toBe('configured');
    expect(proposal!.rawExtraction.coverage).toEqual({ ranges: 1, complete: 1, unread: 0, outputTruncated: 0 });

    // Excerpts are cut from the prepared Markdown, so they carry its markers
    // and do NOT occur in the raw HTML snapshot the check used to read.
    const schedules = proposal!.proposedChanges.schedules!;
    expect(schedules.excerpt).toBe('**First Session:** June 6th - June 20th, 2027');
    expect(proposal!.proposedChanges.applicationUrl!.excerpt).toBe('[Enroll Today!](https://register.pineridge.example/apply)');
    const parsed = parseSnapshotSourceRef(proposal!.snapshotRef!)!;
    const snapshot = (await (fixture.store as SnapshotStore).get(parsed.sourceId, parsed.bodyHash))!;
    expect(resolveReviewExcerpt(schedules.excerpt!, snapshot.body).state).toBe('approximate_stale');
    // They resolve exactly in the prepared text, which is bound by digest to that snapshot.
    const citation = resolveCitationText({ snapshotRef: proposal!.snapshotRef!, snapshot, preparedArtifact: proposal!.rawExtraction.preparedArtifact });
    expect(citation.ok && citation.space).toBe('prepared');
    for (const diff of Object.values(proposal!.proposedChanges)) {
      expect(diff.locator).toMatch(/^chars:\d+-\d+$/);
      expect(resolveReviewExcerpt(diff.excerpt!, (citation as { text: string }).text, diff.locator).state).toBe('verified');
    }

    const applied = await approveAll(proposal!);
    expect([...applied.appliedFields].sort()).toEqual(['ageGroups', 'applicationUrl', 'pricing', 'schedules']);
    expect(applied.provenanceErrors).toEqual([]);

    // The rows are the page's, once each: the two ranch programs share an age
    // band, a price and a second session, and none of those is written twice.
    expect((await campRow(campId)).name).toBe(CAMP_NAME);
    expect((await campRow(campId)).applicationUrl).toBe('https://register.pineridge.example/apply');
    expect(await listRows(campId)).toEqual({
      sessions: [
        { start: '2027-06-06', end: '2027-06-20' },
        { start: '2027-06-06', end: '2027-07-06' },
        { start: '2027-06-22', end: '2027-07-06' },
        { start: '2027-07-10', end: '2027-08-09' },
      ],
      prices: [{ amount: 3850, unit: 'PER_SESSION' }, { amount: 7400, unit: 'PER_SESSION' }],
      ages: [{ minAge: 8, maxAge: 10 }, { minAge: 9, maxAge: 17 }],
    });

    // The stored evidence says which text its locator indexes, and the public
    // trust read resolves it there.
    const bundle = await loadClaimBundle(getTestPool(), [{ subjectType: campfitVocabulary.subjectType, subjectId: campId }]);
    const evidence = bundle.evidence.find((item) => item.claimId === `camp.${campId}.field.applicationUrl`)!;
    expect(evidence.metadata?.citationSpace).toBe('prepared');
    expect(evidence.excerptOrSummary).toBe('[Enroll Today!](https://register.pineridge.example/apply)');
    const displays = await loadCampTrustDisplays(campId, ['applicationUrl', 'schedules']);
    expect(displays.fields.applicationUrl!.evidenceState).toBe('verified_current');
    expect(displays.fields.schedules!.evidenceState).toBe('verified_current');
  });

  it('refuses an excerpt that is not an exact citation, as a 422 naming the field, and applies nothing', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [created] = await proposalsFor(campId);

    // One character off: the page says "Enroll Today!".
    await getTestPool().query(
      `UPDATE "CampChangeProposal" SET "proposedChanges" = jsonb_set("proposedChanges", '{applicationUrl,excerpt}', $2::jsonb) WHERE id = $1`,
      [created!.id, JSON.stringify('[Enroll Today?](https://register.pineridge.example/apply)')],
    );
    const proposal = (await getProposal(created!.id))!;
    const session = await openSession(proposal);

    const refusal = await applyProposalReview({ proposalId: proposal.id, reviewSessionId: session.id, reviewer: REVIEWER, keepPending: false })
      .then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReviewApplyCitationError);
    expect((refusal as ReviewApplyCitationError).fields).toEqual(['applicationUrl']);

    requireAdminAccessMock.mockResolvedValue({ access: { email: REVIEWER } });
    const response = await approveRoute(
      new Request(`http://localhost/api/admin/review/${proposal.id}/approve`, { method: 'POST', body: JSON.stringify({ reviewSessionId: session.id }) }),
      { params: Promise.resolve({ id: proposal.id }) },
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.fields).toEqual(['applicationUrl']);
    expect(body.error).toContain('"applicationUrl"');
    expect(body.error).toContain('does not match the stored source text exactly');

    // Nothing was written, and the proposal is still reviewable.
    expect((await campRow(campId)).applicationUrl).toBeNull();
    expect(await listRows(campId)).toEqual({ sessions: [], prices: [], ages: [] });
    expect((await getProposal(proposal.id))!.status).toBe('PENDING');
  });
});

describe('values outside a field\'s schema are flagged, never proposed, never reported as applied', () => {
  it('drops out-of-set enums and year-less dates from the proposal and names them for the reviewer', async () => {
    const campId = await seedCamp();
    fixture.proposals = [...recorded.programs, ...recorded.invalidValues];
    fixture.html = listingHtml();

    const { entry } = await crawl([campId]);
    const [proposal] = await proposalsFor(campId);

    expect(proposal!.proposedChanges.campTypes).toBeUndefined();
    expect(proposal!.proposedChanges.registrationStatus).toBeUndefined();
    expect(proposal!.proposedChanges.registrationOpenDate).toBeUndefined();
    const refused = Object.fromEntries(storedRefusedValues(proposal!.rawExtraction).map((r) => [r.field, r.values]));
    expect(refused).toEqual({
      registrationStatus: ['SOLD_OUT'],
      registrationOpenDate: ['January 14'],
      schedules: ['December 21', '2026-12-22'],
      campTypes: ['DAY_CAMP', 'DAY'],
    });
    expect(entry(campId).warnings).toContain(
      'campTypes: "DAY_CAMP", "DAY" not proposed — not one of the allowed values (SUMMER_DAY, SLEEPAWAY, FAMILY, VIRTUAL, WINTER_BREAK, SCHOOL_BREAK)',
    );
    // A session with no year is not a date. With some sessions unusable the
    // whole list change waits, so approving cannot archive the others.
    expect(proposal!.proposedChanges.schedules).toBeUndefined();
    expect(entry(campId).warnings?.some((w) => w.startsWith('sessions change withheld: 4 complete session(s)'))).toBe(true);
    // Capitalised platform names are the declared ones; they are kept.
    expect(proposal!.proposedChanges.socialLinks!.new).toEqual({
      instagram: 'https://www.instagram.com/pineridgecamps/',
      x: 'https://x.com/pineridgecamps/',
      youtube: 'https://www.youtube.com/user/pineridgecamps',
    });

    const applied = await approveAll(proposal!);
    expect(applied.appliedFields).not.toContain('campTypes');
    expect((await campRow(campId)).campTypes).toEqual([]);
    expect((await campRow(campId)).registrationStatus).toBe('OPEN');
  });

  it('refuses an approved campTypes value outside the allowed set (422) instead of reporting it applied', async () => {
    const campId = await seedCamp();
    // The exact proposal a live run produced before values were screened.
    const proposalId = await createProposal({
      campId,
      crawlRunId: await seedRun(),
      sourceUrl: CAMP_URL,
      rawExtraction: { via: 'traverse-recrawl' },
      proposedChanges: { campTypes: { old: [], new: ['DAY_CAMP', 'DAY'], mode: 'populate', confidence: 1, sourceUrl: CAMP_URL } },
      overallConfidence: 1,
      extractionModel: 'traverse:gpt-6.1-sol',
    });
    const proposal = (await getProposal(proposalId))!;
    const session = await openSession(proposal);

    const refusal = await applyProposalReview({ proposalId, reviewSessionId: session.id, reviewer: REVIEWER, keepPending: false })
      .then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReviewApplyValueError);
    expect((refusal as Error).message).toContain('"campTypes" has value(s) that are not allowed: "DAY_CAMP", "DAY"');

    requireAdminAccessMock.mockResolvedValue({ access: { email: REVIEWER } });
    const response = await approveRoute(
      new Request(`http://localhost/api/admin/review/${proposalId}/approve`, { method: 'POST', body: JSON.stringify({ reviewSessionId: session.id }) }),
      { params: Promise.resolve({ id: proposalId }) },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).fields).toEqual(['campTypes']);

    expect((await campRow(campId)).campTypes).toEqual([]);
    const after = (await getProposal(proposalId))!;
    expect(after.status).toBe('PENDING');
    expect(after.appliedFields ?? []).toEqual([]);
  });

  it('refuses to empty an enum list', async () => {
    const campId = await seedCamp();
    await getTestPool().query(`UPDATE "Camp" SET "campTypes" = ARRAY['SLEEPAWAY'] WHERE id = $1`, [campId]);
    const proposalId = await createProposal({
      campId, crawlRunId: await seedRun(), sourceUrl: CAMP_URL, rawExtraction: { via: 'traverse-recrawl' },
      proposedChanges: { campTypes: { old: ['SLEEPAWAY'], new: [], mode: 'update', confidence: 1, sourceUrl: CAMP_URL } },
      overallConfidence: 1, extractionModel: 'traverse:gpt-6.1-sol',
    });
    const session = await openSession((await getProposal(proposalId))!);
    const refusal = await applyProposalReview({ proposalId, reviewSessionId: session.id, reviewer: REVIEWER, keepPending: false })
      .then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReviewApplyValueError);
    expect((refusal as Error).message).toContain('"campTypes" would be emptied');
    expect((await campRow(campId)).campTypes).toEqual(['SLEEPAWAY']);
  });

  it('writes an approved campTypes list to the column it reports as applied', async () => {
    const campId = await seedCamp();
    const propose = async (list: string[]) => createProposal({
      campId,
      crawlRunId: await seedRun(),
      sourceUrl: CAMP_URL,
      rawExtraction: { via: 'traverse-recrawl' },
      proposedChanges: { campTypes: { old: [], new: list, mode: 'populate', confidence: 1, sourceUrl: CAMP_URL } },
      overallConfidence: 1,
      extractionModel: 'traverse:gpt-6.1-sol',
    });
    const singular = async () => (await getTestPool().query(`SELECT "campType" FROM "Camp" WHERE id = $1`, [campId])).rows[0].campType;

    // The camp is seeded SLEEPAWAY. It stays the single type while the list still has it.
    const applied = await approveAll((await getProposal(await propose(['SUMMER_DAY', 'SLEEPAWAY'])))!);
    expect(applied.appliedFields).toEqual(['campTypes']);
    expect((await campRow(campId)).campTypes).toEqual(['SUMMER_DAY', 'SLEEPAWAY']);
    expect(await singular()).toBe('SLEEPAWAY');

    // A list without it: the single type follows the list instead of contradicting it.
    await approveAll((await getProposal(await propose(['FAMILY'])))!);
    expect((await campRow(campId)).campTypes).toEqual(['FAMILY']);
    expect(await singular()).toBe('FAMILY');
  });
});

describe('a crawl advances the crawl clock, not the verification clock', () => {
  it('records the crawl on lastCrawledAt, leaves lastVerifiedAt alone, and stops reselecting the camp', async () => {
    const crawled = await seedCamp();
    const waiting = await seedCamp('pine-ridge-waiting', 'Pine Ridge Waiting');
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();

    expect((await resolveCrawlCandidates({ priority: 'never_crawled', limit: 10 })).map((c) => c.id).sort()).toEqual([crawled, waiting].sort());
    const before = Date.now();
    await crawl([crawled]);

    const row = await campRow(crawled);
    expect(new Date(row.lastCrawledAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(row.lastCrawlAttemptAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // A crawl is not a verification.
    expect(row.lastVerifiedAt).toBeNull();
    expect(row.dataConfidence).toBe('PLACEHOLDER');

    expect((await resolveCrawlCandidates({ priority: 'never_crawled', limit: 10 })).map((c) => c.id)).toEqual([waiting]);
    // Same score otherwise: the camp that has waited longest is first.
    expect((await resolveCrawlCandidates({ priority: 'stale', limit: 10 })).map((c) => c.id)).toEqual([waiting, crawled]);
    expect((await resolveCrawlCandidates({ priority: 'stale', limit: 1 })).map((c) => c.id)).toEqual([waiting]);

    // Once both were crawled today, the one crawled longer ago goes first.
    // A reviewer verifying it in between changes nothing: the queue keys on
    // the crawl clock, not on "lastVerifiedAt".
    await crawl([waiting]);
    await getTestPool().query(`UPDATE "Camp" SET "lastVerifiedAt" = now() WHERE id = $1`, [crawled]);
    expect((await resolveCrawlCandidates({ priority: 'stale', limit: 10 })).map((c) => c.id)).toEqual([crawled, waiting]);
  });

  it('a failed crawl records the attempt only, so a failing camp rotates behind an untried one', async () => {
    const failing = await seedCamp();
    const untried = await seedCamp('pine-ridge-untried', 'Pine Ridge Untried');
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    fixture.providerFails = true;

    const { entry } = await crawl([failing]);
    expect(entry(failing).status).toBe('error');
    const row = await campRow(failing);
    expect(row.lastCrawledAt).toBeNull();
    expect(row.lastCrawlAttemptAt).not.toBeNull();
    expect(row.lastExtractedContentDigest).toBeNull();

    // Still never crawled, but no longer ahead of a camp that was never tried.
    expect((await resolveCrawlCandidates({ priority: 'never_crawled', limit: 10 })).map((c) => c.id)).toEqual([untried, failing]);
  });
});

describe('an unchanged page is not re-read by the model', () => {
  it('skips extraction when only per-request noise differs, and re-extracts when the content changes', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml({ request: '1790821483', cfEmail: '6201030f1222060f0c114c0d1005' });

    const first = await crawl([campId]);
    expect(first.entry(campId).status).toBe('ok');
    expect(modelRequests()).toBe(1);
    expect((await campRow(campId)).lastExtractedContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const firstCrawledAt = (await campRow(campId)).lastCrawledAt as Date;

    // The same page fetched again: new script timings, new CDN email token.
    fixture.html = listingHtml({ request: '1790822331', cfEmail: '35565458457551585b461b5a4752' });
    const second = await crawl([campId]);
    const firstRef = parseSnapshotSourceRef((await proposalsFor(campId))[0]!.snapshotRef!)!;
    const stored = await (fixture.store as SnapshotStore).latest(campId);
    expect(stored!.bodyHash).not.toBe(firstRef.bodyHash); // the raw bytes did change
    expect(modelRequests()).toBe(1); // and still no second model call
    expect(second.entry(campId).status).toBe('no_changes');
    expect(second.entry(campId).skipped).toBe('content_unchanged');
    expect(campLogOutcomeNote(second.entry(campId))).toBe('Page text unchanged since the last complete extraction — not re-read by the model');
    expect(await proposalsFor(campId)).toHaveLength(1);
    expect(second.run.newProposals).toBe(0);
    expect(((await campRow(campId)).lastCrawledAt as Date).getTime()).toBeGreaterThanOrEqual(firstCrawledAt.getTime());

    // A real change (a price) is read again.
    fixture.html = listingHtml().replace('$3,850', '$3,950');
    const third = await crawl([campId]);
    expect(modelRequests()).toBe(2);
    expect(third.entry(campId).skipped).toBeUndefined();
  });

  it('extracts a page whose earlier crawl captured it but never finished extracting, even on a 304', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    // Served only if a request matches neither rule below, i.e. if a re-crawl
    // failed to send the validator. It has no programs, so that would fail.
    fixture.html = '<html><body><main><h1>Not the listing</h1></main></body></html>';
    fixture.responses = [
      { status: 304, whenHeaders: { 'if-none-match': '"listing-v1"' }, repeat: true },
      { body: listingHtml(), headers: { 'content-type': 'text/html; charset=utf-8', etag: '"listing-v1"' }, withoutHeaders: ['if-none-match'], repeat: true },
    ];

    // Crawl 1: snapshot captured (with a validator), extraction failed.
    fixture.providerFails = true;
    const first = await crawl([campId]);
    expect(first.entry(campId).status).toBe('error');
    expect(await (fixture.store as SnapshotStore).latest(campId)).toBeDefined();

    // Crawl 2: the server answers 304 to that snapshot's validator. The page
    // was never extracted, so it is extracted now instead of skipped forever.
    fixture.providerFails = false;
    const second = await crawl([campId]);
    expect(second.entry(campId).status).toBe('ok');
    expect(second.entry(campId).skipped).toBeUndefined();
    expect(await proposalsFor(campId)).toHaveLength(1);

    // Crawl 3: 304 again, and now the text on record was extracted: skipped.
    const before = modelRequests();
    const third = await crawl([campId]);
    expect(modelRequests()).toBe(before);
    expect(third.entry(campId).status).toBe('no_changes');
    expect(third.entry(campId).skipped).toBe('content_unchanged');
  });
});

describe('a run never stays RUNNING after it stopped', () => {
  it('ends FAILED when the run itself throws', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();

    const thrown = await runCrawlPipeline({
      triggeredBy: 'test:real-crawl',
      trigger: 'SCHEDULED',
      campIds: [campId],
      onProgress: (event) => { if (event.type === 'camp_processing') throw new Error('progress stream closed'); },
    }).then(() => null, (error: unknown) => error);
    expect((thrown as Error).message).toBe('progress stream closed');

    const { rows } = await getTestPool().query(`SELECT status, "completedAt", "errorLog" FROM "CrawlRun"`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[0].errorLog.at(-1).error).toBe('run aborted: progress stream closed');
  });

  it('closes out a run whose process died, when the next run starts, and leaves a live run alone', async () => {
    const pool = getTestPool();
    const dead = await pool.query<{ id: string }>(
      `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "totalCamps", "startedAt") VALUES ('cron:scheduled-crawl', 'SCHEDULED', 3, now() - interval '2 hours') RETURNING id`,
    );
    // Old start, but it logged a camp a minute ago: still alive.
    const slow = await pool.query<{ id: string }>(
      `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "totalCamps", "startedAt", "campLog")
       VALUES ('manual', 'MANUAL', 3, now() - interval '2 hours', $1::jsonb) RETURNING id`,
      [JSON.stringify([{ campId: 'c', processedAt: new Date(Date.now() - 60_000).toISOString() }])],
    );
    const fresh = await pool.query<{ id: string }>(
      `INSERT INTO "CrawlRun" ("triggeredBy", trigger, "totalCamps") VALUES ('manual', 'MANUAL', 3) RETURNING id`,
    );

    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);

    const status = async (id: string) => (await getCrawlRun(id))!;
    expect((await status(dead.rows[0]!.id)).status).toBe('FAILED');
    expect((await status(dead.rows[0]!.id)).completedAt).not.toBeNull();
    expect((await status(dead.rows[0]!.id)).errorLog.at(-1)!.error).toContain('never finished');
    expect((await status(slow.rows[0]!.id)).status).toBe('RUNNING');
    expect((await status(fresh.rows[0]!.id)).status).toBe('RUNNING');
    // Idempotent: nothing left to reap.
    expect(await failStaleCrawlRuns()).toEqual([]);
  });
});

describe('a recrawl a reviewer asks for never loses the pending proposal', () => {
  async function manualRecrawl(campId: string) {
    requireAdminAccessMock.mockResolvedValue({ access: { email: REVIEWER } });
    const response = await recrawlRoute(
      new Request(`http://localhost/api/admin/camps/${campId}/crawl`, { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ campId }) },
    );
    expect(response.status).toBe(200);
    const { runId } = await response.json();
    // The route returns once the run has started; wait for it to end.
    for (let i = 0; i < 100; i++) {
      const run = await getCrawlRun(runId);
      if (run && run.status !== 'RUNNING') return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('manual recrawl did not finish');
  }

  it('extracts an unchanged page again and replaces the pending proposal only once the new one exists', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [pending] = await proposalsFor(campId);
    expect(modelRequests()).toBe(1);

    const run = await manualRecrawl(campId);
    expect(run.status).toBe('COMPLETED');
    // Forced: the unchanged page was read again, not skipped.
    expect(modelRequests()).toBe(2);
    expect(run.campLog[0]!.skipped).toBeUndefined();
    const after = await proposalsFor(campId);
    expect(after.map((p) => [p.id === pending!.id, p.status])).toEqual([[true, 'SKIPPED'], [false, 'PENDING']]);
  });

  it('leaves the pending proposal pending when the recrawl writes nothing', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [pending] = await proposalsFor(campId);

    fixture.providerFails = true;
    const run = await manualRecrawl(campId);
    expect(run.status).toBe('FAILED');
    const after = await proposalsFor(campId);
    expect(after.map((p) => [p.id, p.status])).toEqual([[pending!.id, 'PENDING']]);
  });

  it('keeps the pending proposal when the replacement cannot be written', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [pending] = await proposalsFor(campId);
    const pool = getTestPool();
    await pool.query(`CREATE OR REPLACE FUNCTION block_proposal_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture: proposal insert blocked'; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER block_proposal_insert BEFORE INSERT ON "CampChangeProposal" FOR EACH ROW EXECUTE FUNCTION block_proposal_insert()`);

    const run = await manualRecrawl(campId);
    expect(run.errorCount).toBe(1);
    // The insert failed, so nothing was superseded.
    expect((await proposalsFor(campId)).map((p) => [p.id, p.status])).toEqual([[pending!.id, 'PENDING']]);
  });

  it('leaves exactly one pending proposal when two recrawls finish together', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);

    for (let round = 0; round < 4; round++) {
      await Promise.all([manualRecrawl(campId), manualRecrawl(campId)]);
      const statuses = (await proposalsFor(campId)).map((p) => p.status);
      expect(statuses.filter((status) => status === 'PENDING')).toHaveLength(1);
      expect(statuses.filter((status) => status === 'SKIPPED')).toHaveLength(statuses.length - 1);
    }

    // The same guarantee at the write itself, with nothing else in the way.
    const runId = await seedRun();
    await Promise.all(Array.from({ length: 8 }, () => createProposal({
      campId, crawlRunId: runId, sourceUrl: CAMP_URL, rawExtraction: { via: 'traverse-recrawl' },
      proposedChanges: { city: { old: 'Florissant', new: 'Divide', mode: 'update', sourceUrl: CAMP_URL } },
      overallConfidence: 1, extractionModel: 'traverse:gpt-6.1-sol',
    })));
    expect((await proposalsFor(campId)).filter((p) => p.status === 'PENDING')).toHaveLength(1);
  });
});

describe('a crawl after an approval does not ask the reviewer again', () => {
  /** The same reading, worded the way a second model run words it. */
  function reworded(proposals: readonly unknown[]): unknown[] {
    return (proposals as { fieldPath: string; value: unknown; excerpt: string }[]).map((proposal) => {
      // Same excerpt, a slightly different value.
      if (proposal.fieldPath === 'items[].applicationUrl') return { ...proposal, value: 'https://register.pineridge.example/apply/' };
      // Same value, cited with a line more of the page.
      if (proposal.fieldPath.startsWith('items[].ageGroups[].') && proposal.excerpt === 'Ages 8 - 10') return { ...proposal, excerpt: '15 Day Sessions\n*Ages 8 - 10*' };
      return proposal;
    });
  }

  it('withholds a reworded reading of approved evidence, and still proposes a real change', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [first] = await proposalsFor(campId);
    await approveAll(first!);

    // The approval changed the camp, so the page is read once more.
    fixture.proposals = reworded(recorded.programs);
    const after = await crawl([campId]);
    expect(modelRequests()).toBe(2);
    expect(after.entry(campId).status).toBe('no_changes');
    expect(after.run.newProposals).toBe(0);
    expect((await proposalsFor(campId)).map((p) => p.status)).toEqual(['APPROVED']);
    // What was withheld is said, on the crawl log.
    expect(after.entry(campId).warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^applicationUrl: not proposed again — the page text it cites is the text a reviewer approved on \d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^ageGroups: not proposed again — the entries have the values a reviewer approved on \d{4}-\d{2}-\d{2}, only their cited text differs$/),
    ]));
    expect((await campRow(campId)).applicationUrl).toBe('https://register.pineridge.example/apply');

    // That settles it: the same page is not read a third time.
    const settled = await crawl([campId]);
    expect(modelRequests()).toBe(2);
    expect(settled.entry(campId).skipped).toBe('content_unchanged');

    // The page really changes (a price): that is proposed.
    fixture.html = listingHtml().replace('$3,850', '$3,950');
    fixture.proposals = (reworded(recorded.programs) as { fieldPath: string; value: unknown; excerpt: string }[]).map((proposal) => ({
      ...proposal,
      value: proposal.value === 3850 ? 3950 : proposal.value,
      excerpt: proposal.excerpt.replace('$3,850', '$3,950'),
    }));
    const changed = await crawl([campId]);
    expect(modelRequests()).toBe(3);
    expect(changed.entry(campId).status).toBe('ok');
    const proposals = await proposalsFor(campId);
    expect(proposals.map((p) => p.status)).toEqual(['APPROVED', 'PENDING']);
    expect(Object.keys(proposals[1]!.proposedChanges)).toEqual(['pricing']);
    expect((proposals[1]!.proposedChanges.pricing!.new as { amount: number }[]).map((row) => row.amount).sort()).toEqual([3950, 7400]);
  });
});

describe('crawl timestamps come from the database clock', () => {
  it('stamps a proposal after the per-camp lock, so the last writer is the latest proposal', async () => {
    const campId = await seedCamp();
    const runId = await seedRun();
    const holder = await getTestPool().connect();
    let released: Date;
    let writing: Promise<string>;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`camp-proposal:${campId}`]);
      // The writer's transaction starts now and waits for the lock.
      writing = createProposal({
        campId, crawlRunId: runId, sourceUrl: CAMP_URL, rawExtraction: { via: 'traverse-recrawl' },
        proposedChanges: { city: { old: 'Florissant', new: 'Divide', mode: 'update', sourceUrl: CAMP_URL } },
        overallConfidence: 1, extractionModel: 'traverse:gpt-6.1-sol',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      released = (await holder.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    const id = await writing!;
    const { rows } = await getTestPool().query<{ createdAt: Date }>(`SELECT "createdAt" FROM "CampChangeProposal" WHERE id = $1`, [id]);
    // Stamped after the lock was granted, not when the transaction began.
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(released!.getTime());
  });

  it('records an unchanged page\'s freshness on the database clock, whatever the application clock says', async () => {
    const pool = getTestPool();
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);

    // Every value written to "lastCrawledAt" from here on, with the database time of the write.
    await pool.query(`CREATE TABLE crawled_at_log (written TIMESTAMPTZ, at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
    await pool.query(`CREATE OR REPLACE FUNCTION log_crawled_at() RETURNS trigger AS $$ BEGIN INSERT INTO crawled_at_log (written) VALUES (NEW."lastCrawledAt"); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER log_crawled_at BEFORE UPDATE OF "lastCrawledAt" ON "Camp" FOR EACH ROW EXECUTE FUNCTION log_crawled_at()`);
    try {
      // An application clock one hour ahead of the database.
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: Date.now() + 3_600_000 });
      const second = await crawl([campId]);
      expect(second.entry(campId).skipped).toBe('content_unchanged');
      const { rows } = await pool.query<{ off: number }>(`SELECT abs(extract(epoch FROM (written - at)))::float AS off FROM crawled_at_log`);
      // The unchanged-page write and the attempt write.
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.off).toBeLessThan(60);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS log_crawled_at ON "Camp"`);
      await pool.query(`DROP TABLE IF EXISTS crawled_at_log`);
    }
  });
});

describe('the unchanged-page skip only applies to a settled result', () => {
  it('retries a crawl whose proposal could not be written', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    const pool = getTestPool();
    await pool.query(`CREATE OR REPLACE FUNCTION block_proposal_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture: proposal insert blocked'; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER block_proposal_insert BEFORE INSERT ON "CampChangeProposal" FOR EACH ROW EXECUTE FUNCTION block_proposal_insert()`);

    const first = await crawl([campId]);
    expect(first.run.errorCount).toBe(1);
    expect(first.stored.errorLog.at(-1)!.error).toContain('proposal insert blocked');
    expect(await proposalsFor(campId)).toHaveLength(0);
    // Nothing durable came of this crawl, so nothing says the page was read.
    const row = await campRow(campId);
    expect(row.lastExtractedContentDigest).toBeNull();
    expect(row.lastCrawledAt).toBeNull();
    expect(row.lastCrawlAttemptAt).not.toBeNull();

    await pool.query(`DROP TRIGGER block_proposal_insert ON "CampChangeProposal"`);
    const second = await crawl([campId]);
    expect(second.entry(campId).status).toBe('ok');
    expect(second.entry(campId).skipped).toBeUndefined();
    expect(await proposalsFor(campId)).toHaveLength(1);
  });

  it('does not record an incomplete read as the text that was extracted', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    process.env.TRAVERSE_CHUNK_SIZE = '1000';
    fixture.failAfterFirstCall = true;

    const first = await crawl([campId]);
    expect(first.entry(campId).incomplete?.reason).toBe('provider-failure');
    expect((await campRow(campId)).lastExtractedContentDigest).toBeNull();

    // Same page, provider healthy: it is read in full, not skipped.
    fixture.failAfterFirstCall = false;
    delete process.env.TRAVERSE_CHUNK_SIZE;
    const before = modelRequests();
    const second = await crawl([campId]);
    expect(modelRequests()).toBeGreaterThan(before);
    expect(second.entry(campId).skipped).toBeUndefined();
    expect(second.entry(campId).incomplete).toBeUndefined();
    expect((await campRow(campId)).lastExtractedContentDigest).toMatch(/^sha256:/);
  });

  // The rule compares "last crawl" with "decided/changed since". Both are
  // stamped by the database, so an application clock that runs behind or
  // ahead of it (here by 25 ms and by 5 s) changes nothing.
  it.each([0, -25, 25, -5000, 5000])('proposes again after a rejection, and once more after the camp data changes (app clock %i ms off the database)', async (skewMs) => {
    if (skewMs !== 0) vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, now: Date.now() + skewMs });
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [first] = await proposalsFor(campId);

    // Pending: the proposal already carries this page's reading.
    await crawl([campId]);
    expect(modelRequests()).toBe(1);

    // Rejected: the page still says it, so it is read and proposed again.
    await updateProposalStatus(first!.id, 'REJECTED', REVIEWER, 'not now');
    const afterReject = await crawl([campId]);
    expect(modelRequests()).toBe(2);
    expect(afterReject.entry(campId).status).toBe('ok');
    const [, second] = await proposalsFor(campId);
    expect(second!.status).toBe('PENDING');
    expect(Object.keys(second!.proposedChanges).sort()).toEqual(['ageGroups', 'applicationUrl', 'pricing', 'schedules']);

    // Approved: the stored data changed after the last crawl, so the page is
    // compared against it once more. Nothing differs now, and that settles it.
    await approveAll(second!);
    const afterApprove = await crawl([campId]);
    expect(modelRequests()).toBe(3);
    expect(afterApprove.entry(campId).status).toBe('no_changes');
    expect(afterApprove.entry(campId).skipped).toBeUndefined();
    const settled = await crawl([campId]);
    expect(modelRequests()).toBe(3);
    expect(settled.entry(campId).skipped).toBe('content_unchanged');
    expect(await proposalsFor(campId)).toHaveLength(2);
  });
});

describe('batch accept runs the same checks as a single approve', () => {
  async function twoCorroboratingProposals(campId: string) {
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    await crawl([campId], { forceExtract: true });
    const proposals = await proposalsFor(campId);
    expect(proposals).toHaveLength(2);
    return proposals;
  }
  const batch = async (campId: string, proposalId: string, field: string) =>
    applyBatchAcceptedClaims(getTestPool(), {
      selections: [{ proposalId, field }],
      actor: REVIEWER,
      historyByCamp: await getCampProposalHistoryBatch(getTestPool(), [campId]),
    });

  it('applies a corroborated field whose excerpt cites the prepared text', async () => {
    const campId = await seedCamp();
    const [, second] = await twoCorroboratingProposals(campId);
    const result = await batch(campId, second!.id, 'applicationUrl');
    expect(result.outcomes).toEqual([{ proposalId: second!.id, field: 'applicationUrl', status: 'applied' }]);
    expect((await campRow(campId)).applicationUrl).toBe('https://register.pineridge.example/apply');
  });

  it('refuses an inexact citation and writes nothing', async () => {
    const campId = await seedCamp();
    const [, second] = await twoCorroboratingProposals(campId);
    await getTestPool().query(
      `UPDATE "CampChangeProposal" SET "proposedChanges" = jsonb_set("proposedChanges", '{applicationUrl,excerpt}', $2::jsonb) WHERE id = $1`,
      [second!.id, JSON.stringify('[Enroll Today?](https://register.pineridge.example/apply)')],
    );
    const result = await batch(campId, second!.id, 'applicationUrl');
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.status).toBe('error');
    expect(result.outcomes[0]!.message).toContain('does not match the stored source text exactly');
    expect((await campRow(campId)).applicationUrl).toBeNull();
  });

  it('refuses a value outside the allowed set with the same message as a single approve', async () => {
    const campId = await seedCamp();
    const changes = { registrationStatus: { old: 'OPEN', new: 'SOLD_OUT', mode: 'update' as const, confidence: 1, sourceUrl: CAMP_URL } };
    const make = async () => createProposal({
      campId, crawlRunId: await seedRun(), sourceUrl: CAMP_URL, rawExtraction: { via: 'traverse-recrawl' },
      proposedChanges: changes, overallConfidence: 1, extractionModel: 'traverse:gpt-6.1-sol',
    });
    await make();
    const second = await make();
    const result = await batch(campId, second, 'registrationStatus');
    expect(result.outcomes[0]!.status).toBe('error');
    expect(result.outcomes[0]!.message).toContain('"registrationStatus" has value(s) that are not allowed: "SOLD_OUT"');
    expect((await campRow(campId)).registrationStatus).toBe('OPEN');
  });
});

describe('a database that has not had the crawl-state migration', () => {
  it('fails the crawl with an instruction and a FAILED run, from the pipeline and from the cron route', async () => {
    const campId = await seedCamp();
    const pool = getTestPool();
    await pool.query(`ALTER TABLE "Camp" DROP COLUMN "lastCrawlAttemptAt", DROP COLUMN "lastExtractedContentDigest"`);

    const thrown = await runCrawlPipeline({ triggeredBy: 'test:real-crawl', trigger: 'MANUAL', campIds: [campId] })
      .then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(CrawlSchemaOutdatedError);
    expect((thrown as Error).message).toContain('npm run db:migrate');

    process.env.CRON_SECRET = 'test-secret';
    await pool.query(`INSERT INTO "CrawlSchedule" (id, enabled, priority, "batchSize") VALUES ('default', true, 'stale', 1)
                      ON CONFLICT (id) DO UPDATE SET enabled = true, priority = 'stale', "batchSize" = 1`);
    const response = await cronRoute(new Request('http://localhost/api/cron/crawl', { headers: { authorization: 'Bearer test-secret' } }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('migration 022_camp_crawl_attempt_and_content_digest');

    requireAdminAccessMock.mockResolvedValue({ access: { email: REVIEWER } });
    const manual = await recrawlRoute(
      new Request(`http://localhost/api/admin/camps/${campId}/crawl`, { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ campId }) },
    );
    expect(manual.status).toBe(500);
    expect((await manual.json()).error).toContain('npm run db:migrate');

    const runs = await pool.query(`SELECT status, trigger, "errorLog" FROM "CrawlRun" ORDER BY "startedAt"`);
    expect(runs.rows.map((row) => [row.trigger, row.status])).toEqual([['MANUAL', 'FAILED'], ['SCHEDULED', 'FAILED'], ['MANUAL', 'FAILED']]);
    expect(runs.rows[0].errorLog[0].error).toContain('npm run db:migrate');
  });
});

describe('what the skip is keyed on', () => {
  const settled = { lastExtractedContentDigest: 'sha256:abc', latestProposalStatus: null, latestProposalDecidedSinceCrawl: null, changedSinceCrawl: false };

  it('decides each case of the settled-result rule', () => {
    expect(skipEligibleFingerprint(settled, false)).toBe('sha256:abc');
    expect(skipEligibleFingerprint(settled, true)).toBeNull();
    expect(skipEligibleFingerprint({ ...settled, lastExtractedContentDigest: null }, false)).toBeNull();
    expect(skipEligibleFingerprint({ ...settled, latestProposalStatus: 'REJECTED', latestProposalDecidedSinceCrawl: true }, false)).toBeNull();
    expect(skipEligibleFingerprint({ ...settled, latestProposalStatus: 'SKIPPED', latestProposalDecidedSinceCrawl: true }, false)).toBeNull();
    // Rejected before the last crawl: that crawl already read the page again.
    expect(skipEligibleFingerprint({ ...settled, latestProposalStatus: 'REJECTED', latestProposalDecidedSinceCrawl: false }, false)).toBe('sha256:abc');
    expect(skipEligibleFingerprint({ ...settled, latestProposalStatus: 'APPROVED', changedSinceCrawl: true }, false)).toBeNull();
    // Pending wins over "data changed": the pending proposal carries this page's reading.
    expect(skipEligibleFingerprint({ ...settled, latestProposalStatus: 'PENDING', changedSinceCrawl: true }, false)).toBe('sha256:abc');
  });

  it('keeps skipping a camp with a pending proposal after its data changes (a partial approval)', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    const [pending] = await proposalsFor(campId);
    await getTestPool().query(
      `INSERT INTO "CampChangeLog" ("campId", "proposalId", "changedBy", "fieldName", "oldValue", "newValue") VALUES ($1, $2, $3, 'applicationUrl', NULL, 'x')`,
      [campId, pending!.id, REVIEWER],
    );

    const again = await crawl([campId]);
    expect(modelRequests()).toBe(1);
    expect(again.entry(campId).skipped).toBe('content_unchanged');
    expect((await proposalsFor(campId)).map((p) => p.status)).toEqual(['PENDING']);
  });

  it('reads an unchanged page again when the model changes', async () => {
    const campId = await seedCamp();
    fixture.proposals = recorded.programs;
    fixture.html = listingHtml();
    await crawl([campId]);
    await crawl([campId]);
    expect(modelRequests()).toBe(1);

    fixture.model = 'gpt-7-next';
    const other = await crawl([campId]);
    expect(modelRequests()).toBe(2);
    expect(other.entry(campId).skipped).toBeUndefined();
  });
});

describe('test isolation', () => {
  it('writes snapshots under a temp directory, not the developer\'s local store', () => {
    expect(SNAPSHOT_STORE_ROOT.startsWith(os.tmpdir())).toBe(true);
    expect(SNAPSHOT_STORE_ROOT).not.toContain('.kontourai');
  });
});
