/**
 * tests/integration/crawl-run-tracker-resilience.test.ts — regression
 * coverage for campfit#85 code-review finding H1
 * (`.kontourai/flow-agents/orchestrator-convergence/review-code.md`):
 * `crawl-run-tracker.ts`'s `recordItemOutcome`/`recordUnhandledError`/
 * `setTotalCamps` must NEVER let a bookkeeping DB write (`appendCrawlError`/
 * `appendCrawlLog`/`updateCrawlRunProgress`) reject their promise — a
 * transient write failure must be caught, logged, and the run must still
 * reach `finish()` with the correct FAILED/COMPLETED derivation. Pre-fix,
 * these methods awaited `updateCrawlRunProgress` (and friends) with no
 * try/catch, so a failing write rejected the whole method call — which,
 * chained through `crawl-pipeline.ts`'s per-camp `catch` →
 * `recordUnhandledError` → itself rejecting, could escape
 * `Promise.all(domainTasks)` entirely and leave the `CrawlRun` row stuck at
 * `RUNNING` forever, with `finish()`/`completeCrawlRun` never called.
 *
 * `@/lib/admin/crawl-repository` is mocked at the import boundary (only its
 * writes are stubbed — `crawl-run-tracker.ts` source is untouched) so each
 * scenario below can force a specific write to reject without a real DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createCrawlRun = vi.fn();
const updateCrawlRunProgress = vi.fn();
const completeCrawlRun = vi.fn();
const appendCrawlError = vi.fn();
const appendCrawlLog = vi.fn();

vi.mock('@/lib/admin/crawl-repository', () => ({
  createCrawlRun: (...args: unknown[]) => createCrawlRun(...args),
  updateCrawlRunProgress: (...args: unknown[]) => updateCrawlRunProgress(...args),
  completeCrawlRun: (...args: unknown[]) => completeCrawlRun(...args),
  appendCrawlError: (...args: unknown[]) => appendCrawlError(...args),
  appendCrawlLog: (...args: unknown[]) => appendCrawlLog(...args),
}));

import { startRun } from '@/lib/ingestion/crawl-run-tracker';

const BASE_RUN = {
  id: 'run-h1',
  startedAt: '2026-07-06T00:00:00.000Z',
  completedAt: null,
  status: 'RUNNING' as const,
  totalCamps: 2,
  processedCamps: 0,
  errorCount: 0,
  newProposals: 0,
  trigger: 'MANUAL' as const,
  triggeredBy: 'test:h1-resilience',
  campIds: null,
  errorLog: [],
  campLog: [],
};

beforeEach(() => {
  createCrawlRun.mockResolvedValue({ ...BASE_RUN });
  updateCrawlRunProgress.mockResolvedValue(undefined);
  completeCrawlRun.mockResolvedValue(undefined);
  appendCrawlError.mockResolvedValue(undefined);
  appendCrawlLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('crawl-run-tracker resilience to bookkeeping-write failures (campfit#85 review H1)', () => {
  it('recordItemOutcome never rejects when its progress write fails, and the run still completes via finish()', async () => {
    updateCrawlRunProgress.mockRejectedValueOnce(new Error('transient PG blip'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const tracker = await startRun({ triggeredBy: 'test', totalCamps: 1 });

    await expect(
      tracker.recordItemOutcome({
        status: 'error',
        campId: 'camp-1',
        campName: 'Camp One',
        url: 'https://example.test/1',
        model: 'stub-model',
        durationMs: 5,
        error: 'extraction failed',
      })
    ).resolves.toBeUndefined();

    const run = await tracker.finish();
    expect(completeCrawlRun).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('FAILED'); // 1/1 processed, all errored
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('updateCrawlRunProgress'));

    warnSpy.mockRestore();
  });

  it('a progress-write failing on an item error AND on the following recordUnhandledError call ("fails twice in a row") still reaches finish() with COMPLETED/FAILED derived correctly — never stuck at RUNNING', async () => {
    // First item: recordItemOutcome's own progress write fails.
    updateCrawlRunProgress.mockRejectedValueOnce(new Error('transient PG blip #1'));
    // Second item: recordUnhandledError's progress write ALSO fails — the
    // review's "fails twice in a row" scenario (item error, then the
    // recordUnhandledError call whose write also fails).
    updateCrawlRunProgress.mockRejectedValueOnce(new Error('transient PG blip #2'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const tracker = await startRun({ triggeredBy: 'test', totalCamps: 2 });

    await expect(
      tracker.recordItemOutcome({
        status: 'error',
        campId: 'camp-1',
        campName: 'Camp One',
        url: 'https://example.test/1',
        model: 'stub-model',
        durationMs: 5,
        error: 'first item error',
      })
    ).resolves.toBeUndefined();

    await expect(
      tracker.recordUnhandledError({
        campId: 'camp-2',
        campName: 'Camp Two',
        url: 'https://example.test/2',
        error: 'second, unhandled error (its own progress write also fails)',
      })
    ).resolves.toBeUndefined();

    // The run must reach finish() — this is the crux of H1: pre-fix, the
    // second rejected updateCrawlRunProgress call would have propagated out
    // of recordUnhandledError, and this assertion would never run.
    const run = await tracker.finish();

    expect(completeCrawlRun).toHaveBeenCalledTimes(1);
    expect(completeCrawlRun).toHaveBeenCalledWith(
      'run-h1',
      'FAILED',
      expect.arrayContaining([
        expect.objectContaining({ campId: 'camp-1', error: 'first item error' }),
        expect.objectContaining({ campId: 'camp-2', error: expect.stringContaining('second, unhandled error') }),
      ])
    );
    expect(run.status).toBe('FAILED'); // 2/2 processed, both errored
    expect(run.processedCamps).toBe(2);
    expect(run.errorCount).toBe(2);

    // Both failures were surfaced as warnings, not silently swallowed.
    expect(warnSpy.mock.calls.filter(([msg]) => String(msg).includes('updateCrawlRunProgress')).length).toBe(2);

    warnSpy.mockRestore();
  });

  it('appendCrawlError/appendCrawlLog write failures inside recordItemOutcome are also guarded — the run still derives COMPLETED on a fully-successful mixed scenario without those writes ever landing', async () => {
    appendCrawlError.mockRejectedValue(new Error('errorLog append blip'));
    appendCrawlLog.mockRejectedValue(new Error('campLog append blip'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const tracker = await startRun({ triggeredBy: 'test', totalCamps: 2 });

    await expect(
      tracker.recordItemOutcome({
        status: 'error',
        campId: 'camp-1',
        campName: 'Camp One',
        url: 'https://example.test/1',
        model: 'stub-model',
        durationMs: 5,
        error: 'boom',
      })
    ).resolves.toBeUndefined();

    await expect(
      tracker.recordItemOutcome({
        status: 'ok',
        campId: 'camp-2',
        campName: 'Camp Two',
        url: 'https://example.test/2',
        model: 'stub-model',
        durationMs: 5,
        fieldsChanged: ['name'],
        proposalId: 'proposal-1',
        confidence: 0.9,
        newProposalsDelta: 1,
      })
    ).resolves.toBeUndefined();

    const run = await tracker.finish();
    expect(completeCrawlRun).toHaveBeenCalledTimes(1);
    // Mixed run (1 ok, 1 error out of 2) → COMPLETED — the shared
    // FAILED-iff-all-errored formula still derives correctly from the
    // tracker's own in-memory counters even though the incremental
    // campLog/errorLog writes above never landed.
    expect(run.status).toBe('COMPLETED');
    expect(run.processedCamps).toBe(2);
    expect(run.errorCount).toBe(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
