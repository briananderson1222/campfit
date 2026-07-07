/**
 * tests/integration/admin-scrape-route.test.ts — campfit#85 (WS11 Slice 4)
 * Wave 4 acceptance evidence for `POST /api/admin/scrape`'s convergence onto
 * `runCrawlPipeline({ sources, ... })`.
 *
 * Per `onboard-url-outcomes.test.ts`'s precedent (no route-handler-via-HTTP
 * harness existed before that file; this reuses the same shape): import the
 * route's exported `POST` directly, call it with a real `Request`, and
 * `vi.mock` only import boundaries — `app/api/admin/scrape/route.ts` source
 * is never modified by this file, only its imports are stubbed.
 *
 * `@/lib/ingestion/crawl-pipeline`'s `runCrawlPipeline` is mocked (not
 * exercised for real) — Wave 3's own
 * `tests/integration/crawl-pipeline-sources-strategy.test.ts` already covers
 * the tracker/DB-write behavior *inside* `runCrawlPipeline`; this file's job
 * is only to prove the ROUTE calls that one seam correctly for the live
 * (`dryRun=false`) path — including wiring `onSourceResult` to rebuild the
 * pre-existing per-source `results` response shape — and preserves its
 * pre-existing direct-pipeline dry-run contract untouched (never a
 * `CrawlRun`, never routed to the tracker) for the `dryRun=true` path — plus
 * that auth/validation still hold.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ── Import-boundary mocks (route.ts source untouched — only imports stubbed) ──

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

import { DatumError } from '@kontourai/datum';
import { POST } from '@/app/api/admin/scrape/route';

const CRON_SECRET = 'test-cron-secret';

function postRequest(body: Record<string, unknown>, authorized = true): Request {
  return new Request('http://localhost/api/admin/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorized ? { authorization: `Bearer ${CRON_SECRET}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const stubSourceResult = {
  source: 'avid4',
  url: 'https://avid4.com/day-camps/colorado/',
  ok: true,
  itemCount: 2,
  routedProposalIds: ['proposal-1', 'proposal-2'],
  routedFieldCount: 5,
  snapshotRef: 'traverse-snapshot:stub',
  snapshotBodyHash: 'stub-hash',
  fetchError: null,
  extractionError: null,
  warnings: [],
  tokensUsed: 500,
  providerCalls: 1,
  model: 'stub-model',
  latencyMs: 42,
};

const expectedResponseResult = {
  source: 'avid4',
  url: 'https://avid4.com/day-camps/colorado/',
  ok: true,
  itemCount: 2,
  routedFieldCount: 5,
  tokensUsed: 500,
  model: 'stub-model',
  latencyMs: 42,
  fetchError: null,
  extractionError: null,
  warnings: [],
};

beforeAll(() => {
  process.env.CRON_SECRET = CRON_SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/scrape', () => {
  it('rejects a request with no/wrong CRON_SECRET bearer token (401), auth check unaffected by convergence', async () => {
    const res = await POST(postRequest({ dryRun: true }, false));
    expect(res.status).toBe(401);
    expect(runCrawlPipeline).not.toHaveBeenCalled();
    expect(runTraversePipeline).not.toHaveBeenCalled();
  });

  it('rejects an unknown source key (400), before either strategy runs', async () => {
    const res = await POST(postRequest({ source: 'not-a-real-source', dryRun: true }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Unknown source/);
    expect(runCrawlPipeline).not.toHaveBeenCalled();
    expect(runTraversePipeline).not.toHaveBeenCalled();
  });

  describe('dryRun=true — unchanged, direct-pipeline contract (never converged, never persists)', () => {
    it('returns the pre-existing per-source results shape and never calls runCrawlPipeline', async () => {
      resolveExtractionProvider.mockReturnValue({ provider: { name: 'stub-provider' } });
      runTraversePipeline.mockResolvedValue([stubSourceResult]);

      const res = await POST(postRequest({ source: 'avid4', dryRun: true }));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.results).toEqual([expectedResponseResult]);
      expect(data.runId).toBeUndefined();

      expect(runCrawlPipeline).not.toHaveBeenCalled();
      // dry-run mode: fetch mode "live" (no snapshot capture), never
      // "live-with-capture" — matches the pre-convergence contract exactly.
      expect(runTraversePipeline).toHaveBeenCalledTimes(1);
      const [, deps] = runTraversePipeline.mock.calls[0];
      expect(deps.mode).toBe('live');
      // The sink must never persist anything in dry-run — calling it must
      // resolve to null with no observable effect.
      await expect(deps.sink({}, {})).resolves.toBeNull();
    });

    it('surfaces a DatumError provider-resolution failure as a 500, unaffected by convergence — INTENTIONALLY diverges from the dryRun=false provider-init-failure test below (see that test\'s own doc, and the deliver artifact\'s "Reconciliation note (Wave 4 reports)" section, orchestrator-convergence--deliver.md: dry-run keeps this route-level 500 preflight; live mode now surfaces the identical failure as a FAILED run + HTTP 200 instead — a reviewed, deliberate contract decision, not an accidental side effect of the seam convergence, campfit#85 review finding H2)', async () => {
      resolveExtractionProvider.mockImplementation(() => {
        throw new DatumError('MISSING_ENV', 'ZAI_API_KEY is not set');
      });

      const res = await POST(postRequest({ dryRun: true }));
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toMatch(/Could not resolve an extraction provider/);
      expect(runCrawlPipeline).not.toHaveBeenCalled();
      expect(runTraversePipeline).not.toHaveBeenCalled();
    });

    it('dryRun=false: a live-mode provider-init failure resolves as a FAILED run + HTTP 200 (never a 500), with the failure visible on the returned run — deliberate 500→200 contract divergence from the dryRun=true preflight above, per campfit#85 review finding H2 / the deliver artifact\'s Wave 4 reconciliation note', async () => {
      // Mirrors runCrawlPipeline's real `providerInitError` branch
      // (crawl-pipeline.ts's runSourceSweepStrategy): the run resolves
      // (never throws) with status FAILED and a source-level errorLog
      // entry — `onSourceResult` is never invoked for a source skipped
      // because the run-level provider never resolved (see
      // `CrawlOptions.onSourceResult`'s own doc), so `results` stays empty
      // here even though the run itself failed.
      runCrawlPipeline.mockResolvedValue({
        id: 'run-789',
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: '2026-07-06T00:00:01.000Z',
        status: 'FAILED',
        totalCamps: 1,
        processedCamps: 1,
        errorCount: 1,
        newProposals: 0,
        trigger: 'MANUAL',
        triggeredBy: 'admin-api:scrape',
        campIds: null,
        errorLog: [
          {
            campId: 'source:avid4',
            error: 'traverse-recrawl:provider-unavailable: ZAI_API_KEY is not set',
            url: 'https://avid4.com/day-camps/colorado/',
          },
        ],
        campLog: [],
      });

      const res = await POST(postRequest({ source: 'avid4', dryRun: false }));

      // The key H2 assertion: this is a 200, not a 500 — same underlying
      // provider-config failure the dryRun=true test above 500s on.
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runId).toBe('run-789');
      expect(data.status).toBe('FAILED');
      // Not silently dropped: the failure is a real, joinable-to-source
      // identifier on the run this route returns (never a blank campId) —
      // callers polling /api/admin/crawl/[runId]/status(-json) or reading
      // getUnassignedSourceFailures() can see it even though this route's
      // own response body doesn't inline errorLog itself.
      expect(runCrawlPipeline).toHaveBeenCalledTimes(1);
      const resolvedRun = await runCrawlPipeline.mock.results[0].value;
      expect(resolvedRun.status).toBe('FAILED');
      expect(resolvedRun.errorLog).toEqual([
        expect.objectContaining({ campId: 'source:avid4' }),
      ]);
      expect(data.results).toEqual([]);
    });
  });

  describe('dryRun=false — converged onto runCrawlPipeline({ sources }) (campfit#85 AC3)', () => {
    it('calls runCrawlPipeline with the sources strategy, collects onSourceResult, and preserves the results response shape', async () => {
      runCrawlPipeline.mockImplementation(async (opts: { onSourceResult?: (r: unknown) => void }) => {
        opts.onSourceResult?.(stubSourceResult);
        return {
          id: 'run-123',
          startedAt: '2026-07-06T00:00:00.000Z',
          completedAt: '2026-07-06T00:05:00.000Z',
          status: 'COMPLETED',
          totalCamps: 1,
          processedCamps: 1,
          errorCount: 0,
          newProposals: 1,
          trigger: 'MANUAL',
          triggeredBy: 'admin-api:scrape',
          campIds: null,
          errorLog: [],
          campLog: [],
        };
      });

      const res = await POST(postRequest({ dryRun: false }));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(runCrawlPipeline).toHaveBeenCalledTimes(1);
      const [opts] = runCrawlPipeline.mock.calls[0];
      expect(opts.triggeredBy).toBe('admin-api:scrape');
      expect(opts.trigger).toBe('MANUAL');
      expect(Array.isArray(opts.sources)).toBe(true);
      expect(opts.sources.length).toBeGreaterThan(0);
      expect(typeof opts.onSourceResult).toBe('function');
      // Route no longer hand-rolls its own sink/ensureAnchorCamp/crawlRunId —
      // those are decommissioned in favor of the seam's own internal ones.
      expect(opts.sink).toBeUndefined();

      // Never falls back to the direct pipeline for a live sweep.
      expect(runTraversePipeline).not.toHaveBeenCalled();
      expect(resolveExtractionProvider).not.toHaveBeenCalled();

      expect(data.runId).toBe('run-123');
      expect(data.status).toBe('COMPLETED');
      expect(data.results).toEqual([expectedResponseResult]);
    });

    it('filters to a single source when `source` is provided, same as before', async () => {
      runCrawlPipeline.mockResolvedValue({
        id: 'run-456',
        startedAt: '2026-07-06T00:00:00.000Z',
        completedAt: null,
        status: 'COMPLETED',
        totalCamps: 1,
        processedCamps: 1,
        errorCount: 0,
        newProposals: 0,
        trigger: 'MANUAL',
        triggeredBy: 'admin-api:scrape',
        campIds: null,
        errorLog: [],
        campLog: [],
      });

      await POST(postRequest({ source: 'avid4', dryRun: false }));

      const [opts] = runCrawlPipeline.mock.calls[0];
      expect(opts.sources).toHaveLength(1);
      expect(opts.sources[0].key).toBe('avid4');
    });
  });
});
