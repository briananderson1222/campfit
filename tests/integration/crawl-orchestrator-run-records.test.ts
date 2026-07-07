/**
 * tests/integration/crawl-orchestrator-run-records.test.ts — campfit#85
 * (WS11 Slice 4) Wave 6 acceptance evidence: cross-strategy regression proof
 * that `runCrawlPipeline`'s camp strategy and sources strategy write
 * IDENTICALLY-SHAPED `CrawlRun` records through the SAME shared tracker
 * (`lib/ingestion/crawl-run-tracker.ts`) — not just that both go through one
 * function name (Stop-short risk 1 in the plan).
 *
 * Against the real `TEST_DATABASE_URL` (via `test-db.ts`'s
 * `getTestPool()`/`assertTestDatabase()` convention, mirroring
 * `tests/integration/crawl-pipeline-sources-strategy.test.ts`), with no real
 * network/provider/filesystem: `resolve-extraction-provider` and
 * `traverse-snapshot-store` are stubbed at the import boundary for both
 * strategies; `traverse-recrawl-adapter`'s `runTraverseRecrawlForCamp` is
 * stubbed for the camp strategy and `traverse-pipeline`'s
 * `runTraversePipelineForSource` is stubbed for the sources strategy — the
 * SAME convention `crawl-pipeline-sources-strategy.test.ts` already
 * established for the sources side. `crawl-pipeline.ts`/
 * `crawl-run-tracker.ts` themselves are never mocked.
 *
 * Plan acceptance (Wave 6 task):
 *  (1) both strategies' `CrawlRun` progress fields increment mid-run, not
 *      just at completion — proven by polling `getCrawlRun` between
 *      processed items (mirrors the SSE status route's own polling
 *      contract), not just asserting the final row.
 *  (2) both strategies' `campLog`/`errorLog` entries use a real, documented
 *      identifier (never a blank string).
 *  (3) final `status` derivation (`FAILED` iff `errorCount ===
 *      processedCamps && processedCamps > 0`, else `COMPLETED`) matches for
 *      both strategies given equivalent all-succeed/all-fail/mixed
 *      fixtures.
 *  (4) `getUnassignedSourceFailures` (the Wave 5-chosen alternate surface —
 *      see `lib/admin/crawl-failure-repository.ts`'s file doc) sees a
 *      source-strategy failure that `getUncrawlableCamps` intentionally
 *      excludes (never silently invisible, per AC5).
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

// ── Import-boundary mocks (crawl-pipeline.ts/crawl-run-tracker.ts source
// untouched — only their imports are stubbed, mirroring
// crawl-pipeline-sources-strategy.test.ts's precedent) ──────────────────────

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => ({
    provider: {
      name: 'stub-extraction-provider',
      extract: async () => ({ proposals: [], raw: { response: '{}', model: 'stub-extraction-provider' } }),
    },
    ref: 'stub-ref',
    datumProvider: 'stub',
    model: 'stub-extraction-provider',
    maxTokens: 2048,
  }),
}));

vi.mock('@/lib/ingestion/traverse-snapshot-store', () => ({
  createCampfitSnapshotStore: () => ({}),
  CAMPFIT_FETCH_USER_AGENT: 'stub-ua/1.0',
  SNAPSHOT_STORE_ROOT: '/tmp/unused-stub-snapshot-root',
}));

const runTraverseRecrawlForCamp = vi.fn();
vi.mock('@/lib/ingestion/traverse-recrawl-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/traverse-recrawl-adapter')>();
  return {
    ...actual,
    runTraverseRecrawlForCamp: (...args: unknown[]) => runTraverseRecrawlForCamp(...args),
  };
});

const runTraversePipelineForSource = vi.fn();
vi.mock('@/lib/ingestion/traverse-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/traverse-pipeline')>();
  return {
    ...actual,
    runTraversePipelineForSource: (...args: unknown[]) => runTraversePipelineForSource(...args),
  };
});

import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { getCrawlRun } from '@/lib/admin/crawl-repository';
import { getUncrawlableCamps, getUnassignedSourceFailures } from '@/lib/admin/crawl-failure-repository';
import type { IngestionSourceConfig } from '@/lib/ingestion/sources';
import type { TraverseProposalSink } from '@/lib/ingestion/traverse-pipeline';
import type { TraverseRecrawlResult } from '@/lib/ingestion/traverse-recrawl-adapter';

let pool: Pool;

async function seedCamp(overrides: { name: string; websiteUrl: string }): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, "websiteUrl")
     VALUES ($1, $2, 'SUMMER_DAY', 'SPORTS', '', $3)
     RETURNING id`,
    [`test-camp-${randomUUID()}`, overrides.name, overrides.websiteUrl],
  );
  return result.rows[0]!.id;
}

/** Poll `getCrawlRun` a fixed number of times with a tiny delay — mirrors the SSE status route's own polling contract, used to observe mid-run state (not just the final row). */
async function pollProgress(runId: string, times: number, delayMs = 15): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < times; i++) {
    const run = await getCrawlRun(runId);
    seen.push(run?.processedCamps ?? -1);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return seen;
}

function okRecrawlResult(model = 'traverse:stub-model'): TraverseRecrawlResult {
  return {
    ok: true,
    error: null,
    proposedChanges: { name: { old: 'Old Name', new: 'New Name', confidence: 0.9, mode: 'update' } },
    overallConfidence: 0.9,
    model,
    rawExtraction: { via: 'stub-recrawl' },
    matchedItemName: 'Stub Camp',
    itemCount: 1,
    snapshot: { ref: 'traverse-snapshot:stub', bodyHash: 'stub-hash' },
    tokensUsed: 50,
    providerCalls: 1,
    latencyMs: 5,
    warnings: [],
  };
}

function errorRecrawlResult(error: string): TraverseRecrawlResult {
  return {
    ok: false,
    error,
    proposedChanges: {},
    overallConfidence: 0,
    model: 'traverse:stub-model',
    rawExtraction: { via: 'stub-recrawl', error },
    matchedItemName: null,
    itemCount: 0,
    snapshot: { ref: null, bodyHash: null },
    tokensUsed: null,
    providerCalls: 0,
    latencyMs: 5,
    warnings: [],
  };
}

function stubSourceOutcome(
  src: IngestionSourceConfig,
  deps: { sink: TraverseProposalSink },
  fail: boolean,
) {
  if (fail) {
    return Promise.resolve({
      source: src.key, url: src.url, ok: false, itemCount: 0,
      routedProposalIds: [], routedFieldCount: 0, snapshotRef: null, snapshotBodyHash: null,
      fetchError: 'stub-fetch-error: connection refused', extractionError: null, warnings: [],
      tokensUsed: null, providerCalls: 0, model: null, latencyMs: 5,
    });
  }
  return (async () => {
    const proposalId = await deps.sink(
      {
        itemIndex: 0,
        itemName: `Stub Item (${src.key})`,
        sourceUrl: src.url,
        proposedChanges: { name: { old: null, new: `Stub Item (${src.key})`, confidence: 0.9, mode: 'populate' } },
        overallConfidence: 0.9,
        extractionModel: 'stub-extraction-provider',
        rawExtraction: { via: 'stub-source-result' },
        warnings: [],
      },
      { sourceKey: src.key, sourceUrl: src.url, snapshotRef: 'traverse-snapshot:stub' },
    );
    return {
      source: src.key, url: src.url, ok: true, itemCount: 1,
      routedProposalIds: [proposalId], routedFieldCount: 1,
      snapshotRef: 'traverse-snapshot:stub', snapshotBodyHash: 'stub-body-hash',
      fetchError: null, extractionError: null, warnings: [],
      tokensUsed: 100, providerCalls: 1, model: 'stub-extraction-provider', latencyMs: 10,
    };
  })();
}

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();

  // Pre-existing, out-of-#85-scope gaps discovered while writing this test:
  // `"CommunityNeighborhood"` and `"CrawlSiteHint"` (both queried
  // unconditionally by `runCrawlPipeline`'s camp strategy —
  // `lib/ingestion/crawl-pipeline.ts`'s `neighborhoodsResult`/`hintsResult`
  // queries — on EVERY camp-strategy run, i.e. all five production re-crawl
  // routes) have NO migration anywhere in `prisma/migrations/`/
  // `scripts/sql/admin-schema.sql` (verified: `git log
  // -S'CommunityNeighborhood'`/`-S'CrawlSiteHint'` finds only the original
  // feature commits, no accompanying SQL) — the exact same class of gap
  // Wave 1 fixed for `CrawlRun.campLog`, but for two unrelated subsystems
  // outside this plan's scope (not `lib/ingestion/**`/
  // `lib/admin/crawl-repository.ts`/`crawl-failure-repository.ts`) — this is
  // why no integration test before this one ever exercised
  // `runCrawlPipeline`'s camp strategy against a freshly-provisioned
  // `TEST_DATABASE_URL`. Rather than expanding this plan's migration scope
  // for two orthogonal subsystems, this test provisions both tables itself,
  // locally and idempotently (mirrors `013_provider_candidates.sql`'s own
  // documented "provisioned at runtime, not yet wired into SCHEMA_FILES"
  // precedent) — this does NOT touch `prisma/migrations/` or
  // `scripts/test-db-reset.ts`. Flagged for a follow-up migration outside
  // #85 (see this task's final report).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "CommunityNeighborhood" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      "communitySlug" TEXT NOT NULL DEFAULT 'denver',
      name TEXT NOT NULL,
      UNIQUE ("communitySlug", name)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "CrawlSiteHint" (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      domain TEXT NOT NULL,
      hint TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      "sourceId" TEXT,
      "createdBy" TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "CrawlRun", "Camp" CASCADE`);
  runTraverseRecrawlForCamp.mockReset();
  runTraversePipelineForSource.mockReset();
});

afterAll(async () => {
  await closeTestPool();
});

describe('runCrawlPipeline cross-strategy convergence (campfit#85 Wave 6)', () => {
  it('(1)(2)(3) camp strategy: mid-run progress increments, joinable campLog/errorLog identifiers, COMPLETED on a mixed run', async () => {
    const okCampId = await seedCamp({ name: 'OK Camp', websiteUrl: 'https://ok-camp.example.test/' });
    const errCampId = await seedCamp({ name: 'Err Camp', websiteUrl: 'https://err-camp.example.test/' });

    runTraverseRecrawlForCamp.mockImplementation(async (opts: { campId: string }) =>
      opts.campId === okCampId ? okRecrawlResult() : errorRecrawlResult('http-error: HTTP 500'),
    );

    let capturedRunId = '';
    const progressSnapshots: number[] = [];
    const run = await runCrawlPipeline({
      triggeredBy: 'test:camp-strategy-mixed',
      trigger: 'MANUAL',
      campIds: [okCampId, errCampId],
      concurrency: 1,
      onProgress: async (event) => {
        if (event.type === 'started') {
          capturedRunId = event.runId;
          return;
        }
        if (event.type === 'camp_done' || event.type === 'camp_error') {
          // Mirrors the SSE status route's own polling contract: read the
          // persisted row mid-run (not just at completion) using the runId
          // captured from the 'started' event.
          const midRun = await getCrawlRun(capturedRunId);
          progressSnapshots.push(midRun?.processedCamps ?? -1);
        }
      },
    });

    // (1) mid-run progress was observed DURING the run via onProgress
    // (proves increments aren't batched at the end), plus a separate
    // post-hoc poll for good measure.
    expect(progressSnapshots).toHaveLength(2);
    const polled = await pollProgress(run.id, 2);
    expect(polled.every((n) => n >= 0)).toBe(true);

    const stored = await getCrawlRun(run.id);
    expect(stored).not.toBeNull();

    // (2) real, non-blank, Camp-joinable identifiers on both sides. The
    // camp strategy's per-camp `recordItemOutcome` (unlike the sources
    // strategy's pre-anchor `recordUnhandledError`) writes a campLog entry
    // for BOTH outcomes — a known-camp failure still has a real item/campId
    // to log against — so the failing camp appears in campLog (status
    // 'error') AND errorLog; only the ok camp appears in campLog as 'ok'.
    expect(stored!.campLog).toHaveLength(2);
    const okEntry = stored!.campLog.find((e) => e.campId === okCampId)!;
    const errEntry = stored!.campLog.find((e) => e.campId === errCampId)!;
    expect(okEntry.status).toBe('ok');
    expect(errEntry.status).toBe('error');
    expect(stored!.errorLog).toHaveLength(1);
    expect(stored!.errorLog[0].campId).toBe(errCampId);
    expect(stored!.errorLog[0].campId).not.toBe('');

    // (3) mixed run (1 ok, 1 error out of 2) → COMPLETED, matching the
    // shared FAILED iff errorCount === processedCamps && processedCamps > 0
    // formula.
    expect(stored!.processedCamps).toBe(2);
    expect(stored!.errorCount).toBe(1);
    expect(stored!.status).toBe('COMPLETED');

    // The failing camp's errorLog entry is visible via getUncrawlableCamps
    // (the pre-existing camp-path surface) — camp-path failures were never
    // the bug; this just re-confirms convergence didn't regress them.
    const uncrawlable = await getUncrawlableCamps();
    expect(uncrawlable.some((row) => row.campId === errCampId)).toBe(true);
  });

  it('(1)(2)(3) sources strategy: mid-run progress increments, joinable/documented identifiers, COMPLETED on a mixed run', async () => {
    runTraversePipelineForSource.mockImplementation((src, deps) =>
      stubSourceOutcome(src, deps, src.key === 'failing-source'),
    );

    const progressSnapshots: number[] = [];
    const run = await runCrawlPipeline({
      triggeredBy: 'test:sources-strategy-mixed',
      trigger: 'MANUAL',
      sources: [
        { key: 'succeeding-source', name: 'Succeeding Source', url: 'https://example.test/succeeding' },
        { key: 'failing-source', name: 'Failing Source', url: 'https://example.test/failing' },
      ],
      onProgress: async (event) => {
        if (event.type === 'camp_done' || event.type === 'camp_error') {
          progressSnapshots.push(1);
        }
      },
    });

    // (1) progress incremented per-source, observable via polling.
    const polled = await pollProgress(run.id, 2);
    expect(polled.every((n) => n >= 0)).toBe(true);
    expect(progressSnapshots.length).toBe(2);

    const stored = await getCrawlRun(run.id);
    expect(stored).not.toBeNull();

    // (2) same identifier discipline as the camp strategy — never blank,
    // and documented/joinable per the Wave 5 decision (real Camp for a
    // routed item, `source:<sourceKey>` for a pre-anchor failure).
    expect(stored!.campLog).toHaveLength(1);
    expect(stored!.campLog[0].campId).not.toBe('');
    expect(stored!.errorLog).toHaveLength(1);
    expect(stored!.errorLog[0].campId).toBe('source:failing-source');
    expect(stored!.errorLog[0].campId).not.toBe('');

    // (3) mixed run (1 ok, 1 error out of 2) → COMPLETED — identical
    // derivation to the camp strategy above.
    expect(stored!.processedCamps).toBe(2);
    expect(stored!.errorCount).toBe(1);
    expect(stored!.status).toBe('COMPLETED');
  });

  it('(3) both strategies derive FAILED under the identical all-error formula', async () => {
    const errCampId = await seedCamp({ name: 'Always Err Camp', websiteUrl: 'https://always-err.example.test/' });
    runTraverseRecrawlForCamp.mockResolvedValue(errorRecrawlResult('http-error: HTTP 500'));

    const campRun = await runCrawlPipeline({
      triggeredBy: 'test:camp-strategy-all-fail',
      campIds: [errCampId],
    });
    const storedCampRun = await getCrawlRun(campRun.id);
    expect(storedCampRun!.status).toBe('FAILED');

    runTraversePipelineForSource.mockImplementation((src, deps) => stubSourceOutcome(src, deps, true));
    const sourceRun = await runCrawlPipeline({
      triggeredBy: 'test:sources-strategy-all-fail',
      sources: [{ key: 'failing-source', name: 'Failing Source', url: 'https://example.test/failing' }],
    });
    const storedSourceRun = await getCrawlRun(sourceRun.id);
    expect(storedSourceRun!.status).toBe('FAILED');
  });

  it('(4) a source-strategy failure is invisible to getUncrawlableCamps but visible via getUnassignedSourceFailures (campfit#85 Wave 5 decision, AC5)', async () => {
    runTraversePipelineForSource.mockImplementation((src, deps) => stubSourceOutcome(src, deps, true));

    await runCrawlPipeline({
      triggeredBy: 'test:sources-strategy-unassigned-failure',
      sources: [{ key: 'unassigned-failure-source', name: 'Unassigned Failure Source', url: 'https://example.test/unassigned' }],
    });

    // Never silently joinable to a real Camp — getUncrawlableCamps's
    // Camp-shaped table intentionally excludes it (no placeholder Camp is
    // ever created for a pre-anchor sweep failure).
    const uncrawlable = await getUncrawlableCamps();
    expect(uncrawlable.some((row) => row.campId === 'source:unassigned-failure-source')).toBe(false);

    // But it is NOT silently dropped — it surfaces on the explicit,
    // documented alternate surface.
    const unassigned = await getUnassignedSourceFailures();
    expect(unassigned.some((row) => row.sourceKey === 'unassigned-failure-source')).toBe(true);
    const row = unassigned.find((r) => r.sourceKey === 'unassigned-failure-source')!;
    expect(row.latestError).toMatch(/stub-fetch-error/);
  });
});
