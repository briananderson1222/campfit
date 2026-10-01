/**
 * A real crawl, end to end, in the shape a live run produced: the crawl
 * pipeline the cron calls, the real Relay extraction provider (only the model
 * runtime replays a recorded answer), the real recrawl adapter, proposal write,
 * Survey review and apply against a throwaway Postgres.
 *
 * Each block is one defect a live crawl exposed. The page, the model answer and
 * the request noise come from tests/fixtures/real-crawl.
 */
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
  /** Extra oracle responses tried before the default 200. */
  responses: [] as Record<string, unknown>[],
  store: null as unknown,
}));

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => {
    const { provider, runtime } = createReplayProvider(fixture.proposals);
    fixture.runtimes.push(runtime as ReplayRuntime);
    const failing: ExtractionProvider = { ...provider, extract: async () => { throw new Error('fixture: provider unavailable'); } };
    return { provider: fixture.providerFails ? failing : provider, ref: 'replay', datumProvider: 'codex', model: 'gpt-6.1-sol', maxTokens: 2048 };
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
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import {
  applyProposalReview,
  ReviewApplyCitationError,
  ReviewApplyValueError,
} from '@/lib/admin/review-apply';
import { createProposal, getProposal } from '@/lib/admin/review-repository';
import { failStaleCrawlRuns, getCrawlRun } from '@/lib/admin/crawl-repository';
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
  fixture.responses = [];
  fixture.store = null;
  requireAdminAccessMock.mockReset();
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
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
      schedules: ['December 21', 'December 22'],
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

  it('writes an approved campTypes list to the column it reports as applied', async () => {
    const campId = await seedCamp();
    const proposalId = await createProposal({
      campId,
      crawlRunId: await seedRun(),
      sourceUrl: CAMP_URL,
      rawExtraction: { via: 'traverse-recrawl' },
      proposedChanges: { campTypes: { old: [], new: ['SLEEPAWAY', 'SUMMER_DAY'], mode: 'populate', confidence: 1, sourceUrl: CAMP_URL } },
      overallConfidence: 1,
      extractionModel: 'traverse:gpt-6.1-sol',
    });
    const applied = await approveAll((await getProposal(proposalId))!);
    expect(applied.appliedFields).toEqual(['campTypes']);
    expect((await campRow(campId)).campTypes).toEqual(['SLEEPAWAY', 'SUMMER_DAY']);
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
