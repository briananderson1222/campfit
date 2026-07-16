/**
 * tests/integration/crawl-pipeline-sources-strategy.test.ts — campfit#85
 * (WS11 Slice 4) Wave 3 acceptance evidence for the additive `sources`
 * strategy on `runCrawlPipeline` (`lib/ingestion/crawl-pipeline.ts`).
 *
 * Exercises the NEW source-sweep branch against the real `TEST_DATABASE_URL`
 * (via `@/lib/db`'s shared pool, remapped by `global-setup.ts` — same
 * mechanism every other `tests/integration/**` file relies on), with no real
 * network involved: `@/lib/ingestion/resolve-extraction-provider` and
 * `@/lib/ingestion/traverse-snapshot-store` are stubbed at the import
 * boundary (mirrors `onboard-url-outcomes.test.ts`'s precedent — a real
 * datum/API-key dependency and a real filesystem write are both out of scope
 * for this suite), and `@/lib/ingestion/traverse-pipeline`'s
 * `runTraversePipelineForSource` is stubbed so this file isolates
 * `crawl-pipeline.ts`'s NEW per-source outcome-mapping/tracker-wiring logic
 * from traverse's own fetch/extract mechanics (already covered by
 * `scripts/test-traverse-replay.ts`/`scripts/test-recrawl-adapter.ts`).
 * `crawl-pipeline.ts` itself is never mocked — every `CrawlRun`/`Camp`/
 * `CampChangeProposal` assertion below goes through the real, converged
 * tracker against the real test DB.
 *
 * Plan acceptance (Wave 3 task, "A network-free structural/unit test..."):
 *  (a) exactly one CrawlRun created for a `sources` run.
 *  (b) progress increments after each source (not only at the end) — proven
 *      via the `onProgress` event stream's per-source `camp_processing`/
 *      `camp_done`/`camp_error` interleaving, not a single batched update.
 *  (c) a mix of a succeeding and a failing stub source produces one
 *      campLog entry and one errorLog entry, using a real/documented
 *      identifier convention (`sourceFailureCampId`, never `campId: ""`).
 *  (d) final status derivation (`FAILED` iff `errorCount === processedCamps
 *      && processedCamps > 0`, else `COMPLETED`) matches the camp path's
 *      existing formula, covering the mixed AND all-failing cases.
 */
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

// ── Import-boundary mocks (lib/ingestion/** source untouched — only the
// import is stubbed, mirroring onboard-url-outcomes.test.ts's convention) ──

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

const runTraversePipelineForSource = vi.fn();

vi.mock('@/lib/ingestion/traverse-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/traverse-pipeline')>();
  return {
    ...actual,
    runTraversePipelineForSource: (...args: unknown[]) => runTraversePipelineForSource(...args),
  };
});

// campfit#134: `runLookoutCheck` would otherwise attempt a real network
// fetch — stubbed at the import boundary exactly like
// `runTraversePipelineForSource` above. `isLookoutUnchanged` (a pure
// function crawl-pipeline.ts also imports from this module) stays the REAL
// implementation via `importOriginal` passthrough, so `driftGate`'s
// `isLookoutUnchanged(checkResult)` call exercises real classification logic
// against whatever `CheckResult` shape this mock returns.
const runLookoutCheckMock = vi.fn();

vi.mock('@/lib/ingestion/lookout-check-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/lookout-check-adapter')>();
  return {
    ...actual,
    runLookoutCheck: (...args: unknown[]) => runLookoutCheckMock(...args),
  };
});

import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { getCrawlRun } from '@/lib/admin/crawl-repository';
import type { IngestionSourceConfig } from '@/lib/ingestion/sources';
import type { TraverseProposalSink } from '@/lib/ingestion/traverse-pipeline';

// ── Stub per-source outcomes ────────────────────────────────────────────────
//
// One deterministic "succeeding" source (routes exactly one item through the
// sink `runCrawlPipeline` builds — proving the sink's ensureAnchorCamp +
// createProposal + tracker wiring all fire for real against the test DB) and
// one "failing" source (whole-source fetch failure, before any item exists).
function stubSourceResult(
  src: IngestionSourceConfig,
  deps: { sink: TraverseProposalSink }
) {
  if (src.key === 'failing-source') {
    return {
      source: src.key,
      url: src.url,
      ok: false,
      itemCount: 0,
      routedProposalIds: [],
      routedFieldCount: 0,
      snapshotRef: null,
      snapshotBodyHash: null,
      fetchError: 'stub-fetch-error: connection refused',
      extractionError: null,
      warnings: [],
      tokensUsed: null,
      providerCalls: 0,
      model: null,
      latencyMs: 5,
    };
  }

  return (async () => {
    const proposalId = await deps.sink(
      {
        itemIndex: 0,
        itemName: `Stub Camp (${src.key})`,
        sourceUrl: src.url,
        proposedChanges: {
          name: { old: null, new: `Stub Camp (${src.key})`, confidence: 0.9, mode: 'populate' },
        },
        overallConfidence: 0.9,
        extractionModel: 'stub-extraction-provider',
        rawExtraction: { via: 'stub-source-result' },
        warnings: [],
      },
      { sourceKey: src.key, sourceUrl: src.url, snapshotRef: 'traverse-snapshot:stub', snapshotBodyHash: 'stub-body-hash' }
    );
    return {
      source: src.key,
      url: src.url,
      ok: true,
      itemCount: 1,
      routedProposalIds: [proposalId],
      routedFieldCount: 1,
      snapshotRef: 'traverse-snapshot:stub',
      snapshotBodyHash: 'stub-body-hash',
      fetchError: null,
      extractionError: null,
      warnings: [],
      tokensUsed: 100,
      providerCalls: 1,
      model: 'stub-extraction-provider',
      latencyMs: 10,
    };
  })();
}

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
});

afterEach(async () => {
  await pool.query(`TRUNCATE "CrawlRun", "Camp" CASCADE`);
  runTraversePipelineForSource.mockReset();
  runLookoutCheckMock.mockReset();
});

afterAll(async () => {
  await closeTestPool();
});

describe('runCrawlPipeline({ sources }) — additive source-sweep strategy (campfit#85 Wave 3)', () => {
  it('mutual exclusivity: fails loudly when both sources and campIds are set (never silently prefers one)', async () => {
    await expect(
      runCrawlPipeline({
        triggeredBy: 'test:mutual-exclusivity',
        sources: [{ key: 'a', name: 'A', url: 'https://example.test/a' }],
        campIds: ['some-camp-id'],
      })
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('(a)(b)(c) a mixed succeeding+failing sweep: one CrawlRun, live per-source progress, joinable success campId, documented non-blank failure identifier', async () => {
    runTraversePipelineForSource.mockImplementation(stubSourceResult);

    const progressEvents: { type: string }[] = [];
    const run = await runCrawlPipeline({
      triggeredBy: 'test:sources-sweep-mixed',
      trigger: 'MANUAL',
      sources: [
        { key: 'succeeding-source', name: 'Succeeding Source', url: 'https://example.test/succeeding' },
        { key: 'failing-source', name: 'Failing Source', url: 'https://example.test/failing' },
      ],
      onProgress: (event) => {
        progressEvents.push(event as { type: string });
      },
    });

    // (a) exactly one CrawlRun row for this sweep.
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "CrawlRun" WHERE id = $1`,
      [run.id]
    );
    expect(countRows[0].count).toBe('1');

    // (b) progress incremented per-source, not only at the very end — the
    // event stream must interleave a processing/outcome pair for EACH
    // source (never a single batched "everything happened at once" shape).
    const types = progressEvents.map((e) => e.type);
    expect(types[0]).toBe('started');
    expect(types[types.length - 1]).toBe('completed');
    expect(types.filter((t) => t === 'camp_processing')).toHaveLength(2);
    expect(types).toContain('camp_done');
    expect(types).toContain('camp_error');
    // The done/error outcomes must appear BEFORE the run completes (proves
    // per-item persistence happened during the run, not batched at finish()).
    expect(types.indexOf('camp_done')).toBeLessThan(types.indexOf('completed'));
    expect(types.indexOf('camp_error')).toBeLessThan(types.indexOf('completed'));

    // (c) one campLog entry (the succeeding source) + one errorLog entry
    // (the failing source), neither using the pre-convergence blank
    // placeholder.
    const stored = await getCrawlRun(run.id);
    expect(stored).not.toBeNull();
    expect(stored!.campLog).toHaveLength(1);
    expect(stored!.campLog[0].status).toBe('ok');
    expect(stored!.campLog[0].campId).not.toBe('');
    expect(stored!.errorLog).toHaveLength(1);
    expect(stored!.errorLog[0].campId).not.toBe('');
    expect(stored!.errorLog[0].campId).toBe('source:failing-source');
    expect(stored!.errorLog[0].error).toMatch(/stub-fetch-error/);

    // The succeeding source's campId must be a REAL, joinable Camp row (the
    // whole point of ensureAnchorCamp — never an unresolvable placeholder).
    const { rows: campRows } = await pool.query(
      `SELECT id, slug FROM "Camp" WHERE id = $1`,
      [stored!.campLog[0].campId]
    );
    expect(campRows).toHaveLength(1);
    expect(campRows[0].slug).toBe('stub-camp-succeeding-source');

    // (d) final status derivation: errorCount (1) !== processedCamps (2) → COMPLETED.
    expect(stored!.processedCamps).toBe(2);
    expect(stored!.errorCount).toBe(1);
    expect(stored!.newProposals).toBe(1);
    expect(stored!.status).toBe('COMPLETED');
    expect(stored!.totalCamps).toBe(2);
  });

  it('(d) all-failing sweep derives FAILED, matching the camp path\'s existing formula', async () => {
    runTraversePipelineForSource.mockImplementation(stubSourceResult);

    const run = await runCrawlPipeline({
      triggeredBy: 'test:sources-sweep-all-fail',
      trigger: 'MANUAL',
      sources: [
        { key: 'failing-source', name: 'Failing Source One', url: 'https://example.test/failing-1' },
        { key: 'failing-source', name: 'Failing Source Two', url: 'https://example.test/failing-2' },
      ],
    });

    const stored = await getCrawlRun(run.id);
    expect(stored).not.toBeNull();
    expect(stored!.processedCamps).toBe(2);
    expect(stored!.errorCount).toBe(2);
    expect(stored!.status).toBe('FAILED');
    expect(stored!.errorLog).toHaveLength(2);
    expect(stored!.errorLog.every((e) => e.campId === 'source:failing-source')).toBe(true);
  });

  it('campfit#134 driftGate: an authoritative unchanged-304 CHECK skips extraction entirely (no runTraversePipelineForSource call, zero proposals, a no_changes campLog outcome)', async () => {
    // Only an authoritative server 304 (validator match) is render-independent
    // and safe to skip on — see the crawl-pipeline.ts driftGate comment.
    runLookoutCheckMock.mockResolvedValue({
      kind: 'unchanged-304',
      sourceId: 'agg:fixture:drift-source',
      sourceUrl: 'https://example.test/drift-source',
      checkedAt: '2026-07-11T00:00:00.000Z',
      warnings: [],
      snapshotRef: 'traverse-snapshot:stub-304',
    });

    const run = await runCrawlPipeline({
      triggeredBy: 'test:sources-sweep-drift-gate',
      trigger: 'MANUAL',
      driftGate: true,
      sources: [
        { key: 'agg:fixture:drift-source', name: 'Drift Source', url: 'https://example.test/drift-source' },
      ],
    });

    // The CHECK was consulted, and — since it's an authoritative 304 — extraction never ran.
    expect(runLookoutCheckMock).toHaveBeenCalledTimes(1);
    expect(runTraversePipelineForSource).not.toHaveBeenCalled();

    // No CampChangeProposal/Camp row was created — nothing was ever routed.
    const { rows: proposalRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "CampChangeProposal"`
    );
    expect(proposalRows[0].count).toBe('0');

    const stored = await getCrawlRun(run.id);
    expect(stored).not.toBeNull();
    // recordItemOutcome({ status: 'no_changes', ... }) lands in campLog, not
    // errorLog (only status: 'error' pushes to errorLog — crawl-run-tracker.ts).
    expect(stored!.campLog).toHaveLength(1);
    expect(stored!.campLog[0].status).toBe('no_changes');
    expect(stored!.campLog[0].campId).toBe('source:agg:fixture:drift-source');
    expect(stored!.errorLog).toHaveLength(0);
    expect(stored!.newProposals).toBe(0);
    expect(stored!.status).toBe('COMPLETED');
  });

  it('campfit#134 driftGate: an unchanged-HASH CHECK does NOT skip — extraction still runs (JS-shell safety: a byte-identical plain fetch cannot prove rendered content is unchanged)', async () => {
    // The safety-critical property behind the campfit#134 HIGH fix: a plain
    // fetch `unchanged-hash` must fall through to the shell-aware extraction,
    // NEVER skip — otherwise an invariant JS-shell provider page would be
    // skipped permanently after the first run.
    runLookoutCheckMock.mockResolvedValue({
      kind: 'unchanged-hash',
      sourceId: 'succeeding-source',
      sourceUrl: 'https://example.test/succeeding',
      checkedAt: '2026-07-11T00:00:00.000Z',
      warnings: [],
      priorSnapshotRef: 'traverse-snapshot:stub-prior',
      currentSnapshotRef: 'traverse-snapshot:stub-current',
    });
    runTraversePipelineForSource.mockImplementation(stubSourceResult);

    const run = await runCrawlPipeline({
      triggeredBy: 'test:sources-sweep-drift-gate-hash',
      trigger: 'MANUAL',
      driftGate: true,
      sources: [
        { key: 'succeeding-source', name: 'Succeeding Source', url: 'https://example.test/succeeding' },
      ],
    });

    // CHECK ran and returned unchanged-hash, but extraction STILL ran (not skipped).
    expect(runLookoutCheckMock).toHaveBeenCalledTimes(1);
    expect(runTraversePipelineForSource).toHaveBeenCalledTimes(1);

    // The stub routes a real item with a non-empty diff, so a proposal WAS created.
    const stored = await getCrawlRun(run.id);
    expect(stored).not.toBeNull();
    expect(stored!.campLog).toHaveLength(1);
    expect(stored!.campLog[0].status).toBe('ok');
    expect(stored!.newProposals).toBe(1);
    expect(stored!.status).toBe('COMPLETED');
  });

  it('campfit#134 driftGate: absent (default off) still calls runTraversePipelineForSource for every source — the curated INGESTION_SOURCES sweep is unchanged', async () => {
    runTraversePipelineForSource.mockImplementation(stubSourceResult);

    await runCrawlPipeline({
      triggeredBy: 'test:sources-sweep-no-drift-gate',
      trigger: 'MANUAL',
      sources: [
        { key: 'succeeding-source', name: 'Succeeding Source', url: 'https://example.test/succeeding' },
      ],
    });

    expect(runLookoutCheckMock).not.toHaveBeenCalled();
    expect(runTraversePipelineForSource).toHaveBeenCalledTimes(1);
  });
});
