/**
 * tests/integration/scrape-script.test.ts — campfit#85 (WS11 Slice 4) Wave 4
 * acceptance evidence for `scripts/scrape.ts`'s convergence onto
 * `runCrawlPipeline({ sources, ... })`.
 *
 * Network-free, DB-free call-shape check (paired with Wave 3's
 * `tests/integration/crawl-pipeline-sources-strategy.test.ts`, which already
 * covers the tracker/DB-write behavior *inside* `runCrawlPipeline` itself,
 * and mirroring `tests/integration/admin-scrape-route.test.ts`'s import-
 * boundary-mock convention for the sibling route task): proves
 * `scripts/scrape.ts`'s exported `main()` —
 *  (1) for a LIVE sweep, calls `runCrawlPipeline` with the `sources`
 *      strategy (not the old direct `runTraversePipeline` + ad hoc
 *      `createCrawlRun`/`completeCrawlRun` pair), forwarding a real
 *      `currentByItemNames` resolver and consuming the new
 *      `onSourceResult` observer to rebuild its pre-existing per-source
 *      console report (`toIngestionReportEntry`/`summarizeReport`/
 *      `printReport`);
 *  (2) for `--dry-run`, NEVER calls `runCrawlPipeline` (which always
 *      creates a real `CrawlRun` row) — stays on the pre-existing direct-
 *      pipeline, no-DB, no-CrawlRun contract, unchanged.
 *
 * `scripts/scrape.ts` source is never modified by this file, only its
 * imports are stubbed at the module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Import-boundary mocks (scrape.ts source untouched — only imports stubbed) ──

const runCrawlPipeline = vi.fn();
vi.mock('@/lib/ingestion/crawl-pipeline', () => ({
  runCrawlPipeline: (...args: unknown[]) => runCrawlPipeline(...args),
}));

const resolveExtractionProvider = vi.fn();
vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: (...args: unknown[]) => resolveExtractionProvider(...args),
}));

const runTraversePipeline = vi.fn();
vi.mock('@/lib/ingestion/traverse-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/traverse-pipeline')>();
  return {
    ...actual,
    runTraversePipeline: (...args: unknown[]) => runTraversePipeline(...args),
  };
});

vi.mock('@/lib/ingestion/traverse-snapshot-store', () => ({
  createCampfitSnapshotStore: () => ({}),
  CAMPFIT_FETCH_USER_AGENT: 'stub-ua/1.0',
  SNAPSHOT_STORE_ROOT: '/tmp/unused-stub-snapshot-root',
}));

const poolQuery = vi.fn();
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: poolQuery }),
}));

const closeRenderBrowser = vi.fn();
// Sentinel "render available" impl the try-helper hands back. scrape.ts now
// calls tryCreateCampfitRenderImpl() (which degrades to undefined when safe
// browser egress is unavailable — campfit#117); here we return a truthy
// sentinel so this test exercises the render-available wiring shape.
const renderImplSentinel = async () => ({ html: '' });
const tryCreateCampfitRenderImpl = vi.fn((..._args: unknown[]) => renderImplSentinel);
vi.mock('@/lib/ingestion/render-fetch', () => ({
  closeRenderBrowser: (...args: unknown[]) => closeRenderBrowser(...args),
  // scrape.ts imports this to construct the Playwright renderImpl for the
  // shell-detection fallback, degrading to undefined when browser egress is
  // unavailable. This test asserts scrape.ts's CALL SHAPE into
  // runCrawlPipeline/runTraversePipeline, not the renderer itself (real
  // Playwright coverage lives in scripts/test-render-fetch.ts).
  tryCreateCampfitRenderImpl: (...args: unknown[]) => tryCreateCampfitRenderImpl(...args),
}));

import { main } from '@/scripts/scrape';

const ORIGINAL_ARGV = process.argv;

function setArgv(...extra: string[]) {
  process.argv = [ORIGINAL_ARGV[0], '/path/to/scripts/scrape.ts', ...extra];
}

let exitSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveExtractionProvider.mockReturnValue({ provider: { name: 'stub-provider' } });
  poolQuery.mockResolvedValue({ rows: [] });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code}) called`);
  }) as never) as unknown as ReturnType<typeof vi.fn>;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  vi.restoreAllMocks();
});

describe('scripts/scrape.ts main()', () => {
  it('--dry-run stays on the direct pipeline: never calls runCrawlPipeline (no CrawlRun)', async () => {
    setArgv('--dry-run', '--source', 'avid4');
    runTraversePipeline.mockResolvedValue([
      {
        source: 'avid4', url: 'https://avid4.com/day-camps/colorado/', ok: true,
        itemCount: 1, routedProposalIds: [null], routedFieldCount: 2,
        snapshotRef: null, snapshotBodyHash: null, fetchError: null, extractionError: null,
        warnings: [], tokensUsed: 10, providerCalls: 1, model: 'stub-model', latencyMs: 5,
      },
    ]);

    await main();

    expect(runTraversePipeline).toHaveBeenCalledTimes(1);
    const [sources, deps] = runTraversePipeline.mock.calls[0];
    expect(sources).toHaveLength(1);
    expect(sources[0].key).toBe('avid4');
    expect(deps.mode).toBe('live-with-capture');
    // Dry-run's sink must be a true no-op — never persists anything.
    await expect(deps.sink({}, {})).resolves.toBeNull();
    // campfit#53 (spa-ingestion, AC1/AC2): even the dry-run path wires a real
    // renderImpl — scripts/scrape.ts is the ONLY caller that constructs one.
    expect(tryCreateCampfitRenderImpl).toHaveBeenCalledTimes(1);
    expect(tryCreateCampfitRenderImpl).toHaveBeenCalledWith();
    expect(deps.fetchOptions?.renderImpl).toBe(tryCreateCampfitRenderImpl.mock.results[0].value);

    expect(runCrawlPipeline).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('live sweep converges onto runCrawlPipeline({ sources, ... }) and never falls back to the direct pipeline', async () => {
    setArgv();
    runCrawlPipeline.mockImplementation(async (opts: {
      onSourceResult?: (result: unknown) => void | Promise<void>;
    }) => {
      // Exercise the onSourceResult observer the way the real seam does,
      // proving scrape.ts's report-building wiring actually consumes it
      // (the seam itself returns only the CrawlRun, never this array).
      await opts.onSourceResult?.({
        source: 'avid4', url: 'https://avid4.com/day-camps/colorado/', ok: true,
        itemCount: 1, routedProposalIds: ['proposal-1'], routedFieldCount: 1,
        snapshotRef: 'traverse-snapshot:stub', snapshotBodyHash: 'stub-hash',
        fetchError: null, extractionError: null, warnings: [],
        tokensUsed: 100, providerCalls: 1, model: 'stub-model', latencyMs: 12,
      });
      return {
        id: 'run-1', status: 'COMPLETED', totalCamps: 3, processedCamps: 3,
        errorCount: 0, newProposals: 1,
      };
    });

    await main();

    expect(runCrawlPipeline).toHaveBeenCalledTimes(1);
    const [opts] = runCrawlPipeline.mock.calls[0];
    expect(opts.triggeredBy).toBe('scrape:traverse-pipeline');
    expect(opts.trigger).toBe('SCHEDULED');
    expect(Array.isArray(opts.sources)).toBe(true);
    expect(opts.sources.length).toBeGreaterThan(0);
    expect(typeof opts.onSourceResult).toBe('function');
    expect(typeof opts.currentByItemNames).toBe('function');
    // No hand-rolled sink/crawlRunId any more — decommissioned in favor of
    // the seam's own internal ensureAnchorCamp/sink wiring.
    expect(opts.sink).toBeUndefined();
    expect(opts.crawlRunId).toBeUndefined();
    // campfit#53 (spa-ingestion, AC1/AC2/AC7): the live sweep threads a real
    // renderImpl through CrawlOptions.fetchOptions — the GitHub Actions
    // execution context is the only place this is wired (see scrape.ts's
    // own file doc); every Vercel-route caller of runCrawlPipeline leaves
    // this unset (see the per-route doc notes added alongside this task).
    expect(tryCreateCampfitRenderImpl).toHaveBeenCalledTimes(1);
    expect(tryCreateCampfitRenderImpl).toHaveBeenCalledWith();
    expect(opts.fetchOptions?.renderImpl).toBe(tryCreateCampfitRenderImpl.mock.results[0].value);

    // currentByItemNames actually queries the DB pool (not a dead passthrough).
    const current = await opts.currentByItemNames('avid4', ['Some Camp']);
    expect(current).toBeInstanceOf(Map);
    expect(poolQuery).toHaveBeenCalled();

    expect(runTraversePipeline).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
