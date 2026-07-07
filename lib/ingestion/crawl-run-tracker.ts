import { createCrawlRun, updateCrawlRunProgress, completeCrawlRun, appendCrawlError, appendCrawlLog } from '@/lib/admin/crawl-repository';
import type { CrawlProgressEvent, CrawlRun, CrawlCampLogEntry } from '@/lib/admin/types';

/**
 * Shared run-record tracker (campfit#85, WS11 Slice 4, Wave 2).
 *
 * Owns the full `CrawlRun` bookkeeping lifecycle — creation, live
 * progress/campLog/errorLog writes during a run, and final status
 * derivation/completion — so both `runCrawlPipeline` strategies
 * (`lib/ingestion/crawl-pipeline.ts`'s camp-list loop today; the additive
 * source-list strategy landing on the same seam) write through ONE tracker
 * instead of each hand-rolling its own `createCrawlRun`/`appendCrawlLog`/
 * `appendCrawlError`/`updateCrawlRunProgress`/`completeCrawlRun` calls.
 *
 * This is a PURE extraction of what was previously inlined in
 * `runCrawlPipeline`'s per-camp loop — every write this module performs and
 * every `CrawlProgressEvent` it emits is byte-identical in shape/ordering to
 * what the camp-path loop did before this refactor. Domain-specific
 * concerns that are NOT part of run-record plumbing — proposal creation
 * (`createProposal`), provider matching (`matchOrCreateProvider`),
 * extraction metrics (`recordExtractionMetrics`) — stay in the calling
 * strategy's own loop; the tracker only ever sees the already-resolved
 * outcome of that domain work.
 */

export interface StartRunOptions {
  triggeredBy: string;
  trigger?: 'MANUAL' | 'SCHEDULED';
  campIds?: string[];
  totalCamps: number;
  onProgress?: (event: CrawlProgressEvent) => void | Promise<void>;
}

/**
 * A fully-resolved outcome for one processed item (camp or, later, a
 * routed source item) — persists the `campLog` entry (and, for failures,
 * the `errorLog` entry), bumps live progress counters, and emits the
 * matching `camp_done`/`camp_error` progress event. Mirrors the two
 * explicit outcome branches (`result.ok` true/false) `crawl-pipeline.ts`'s
 * per-camp loop previously inlined directly.
 */
export type ItemOutcome =
  | {
      status: 'ok' | 'no_changes';
      campId: string;
      campName: string;
      url: string;
      model: string;
      durationMs: number;
      fieldsChanged: string[];
      providerAction?: string;
      proposalId: string | null;
      confidence: number;
      /** 0 or 1 — whether this item's outcome created a new proposal (the calling loop already decided this; the tracker only accumulates it into the run-level `newProposals` counter). */
      newProposalsDelta: 0 | 1;
    }
  | {
      status: 'error';
      campId: string;
      campName: string;
      url: string;
      model: string;
      durationMs: number;
      error: string;
    };

export interface CrawlRunTracker {
  /** The `CrawlRun` row as created at `startRun` time (id/startedAt/etc. — status/counters are stale after the run starts; use `finish()`'s return value for the final state). */
  run: CrawlRun;
  /** The resolved progress-event emitter (`options.onProgress` or a no-op) — exposed so the calling loop can emit events that aren't tied to a persisted campLog entry (e.g. `camp_processing`, which fires before an outcome exists). */
  emit: (event: CrawlProgressEvent) => void | Promise<void>;
  /** Explicit success/failure outcome — persists campLog (+ errorLog for failures), bumps progress counters, emits `camp_done`/`camp_error`. */
  recordItemOutcome(outcome: ItemOutcome): Promise<void>;
  /**
   * An uncaught-exception outcome — the item's whole processing step threw
   * before producing a `result.ok`-shaped outcome. Mirrors the outer
   * `catch` in the original per-camp loop exactly: bumps
   * processedCamps/errorCount and the in-memory errorLog buffer (persisted
   * wholesale at `finish()`), emits `camp_error` — but, matching prior
   * behavior, does NOT call `appendCrawlError`/`appendCrawlLog` (no
   * campLog entry exists for a step that threw before producing one).
   */
  recordUnhandledError(entry: { campId: string; campName: string; url: string; error: string }): Promise<void>;
  /** Corrects `totalCamps` mid/post-run (matches the prior post-loop `processedCamps > camps.length` discovery fixup). */
  setTotalCamps(totalCamps: number): Promise<void>;
  /** Finalizes the run: derives FAILED/COMPLETED exactly as before, writes the full errorLog, emits `completed`, returns the final `CrawlRun`. */
  finish(): Promise<CrawlRun>;
}

export async function startRun(options: StartRunOptions): Promise<CrawlRunTracker> {
  const emit = options.onProgress ?? (() => {});
  const run = await createCrawlRun({
    triggeredBy: options.triggeredBy,
    trigger: options.trigger ?? 'MANUAL',
    campIds: options.campIds,
    totalCamps: options.totalCamps,
  });

  await emit({ type: 'started', runId: run.id, totalCamps: options.totalCamps });

  let processedCamps = 0;
  let errorCount = 0;
  let newProposals = 0;
  const errorLog: { campId: string; error: string; url: string }[] = [];

  async function recordItemOutcome(outcome: ItemOutcome): Promise<void> {
    if (outcome.status === 'error') {
      errorCount++;
      errorLog.push({ campId: outcome.campId, error: outcome.error, url: outcome.url });
      await appendCrawlError(run.id, { campId: outcome.campId, error: outcome.error, url: outcome.url });
      const entry: CrawlCampLogEntry = {
        campId: outcome.campId, campName: outcome.campName, url: outcome.url,
        status: 'error', model: outcome.model,
        proposals: 0, fieldsChanged: [], error: outcome.error,
        durationMs: outcome.durationMs, processedAt: new Date().toISOString(),
      };
      await appendCrawlLog(run.id, entry);
      await emit({ type: 'camp_error', campId: outcome.campId, campName: outcome.campName, error: outcome.error });
    } else {
      newProposals += outcome.newProposalsDelta;
      const changesFound = outcome.fieldsChanged.length;
      const entry: CrawlCampLogEntry = {
        campId: outcome.campId, campName: outcome.campName, url: outcome.url,
        status: outcome.status, model: outcome.model,
        proposals: outcome.status === 'ok' ? 1 : 0,
        fieldsChanged: outcome.fieldsChanged,
        durationMs: outcome.durationMs, processedAt: new Date().toISOString(),
        ...(outcome.providerAction ? { providerAction: outcome.providerAction } : {}),
      };
      await appendCrawlLog(run.id, entry);
      await emit({ type: 'camp_done', campId: outcome.campId, proposalId: outcome.proposalId, confidence: outcome.confidence, changesFound });
    }
    processedCamps++;
    await updateCrawlRunProgress(run.id, { processedCamps, errorCount, newProposals });
  }

  async function recordUnhandledError(entry: { campId: string; campName: string; url: string; error: string }): Promise<void> {
    errorCount++;
    errorLog.push({ campId: entry.campId, error: entry.error, url: entry.url });
    await emit({ type: 'camp_error', campId: entry.campId, campName: entry.campName, error: entry.error });
    processedCamps++;
    await updateCrawlRunProgress(run.id, { processedCamps, errorCount, newProposals });
  }

  async function setTotalCamps(totalCamps: number): Promise<void> {
    await updateCrawlRunProgress(run.id, { totalCamps });
  }

  async function finish(): Promise<CrawlRun> {
    const finalStatus = errorCount === processedCamps && processedCamps > 0 ? 'FAILED' : 'COMPLETED';
    await completeCrawlRun(run.id, finalStatus, errorLog);
    const finalRun = { ...run, status: finalStatus as 'COMPLETED' | 'FAILED', processedCamps, errorCount, newProposals };
    await emit({ type: 'completed', runId: run.id, stats: { processedCamps, errorCount, newProposals } });
    return finalRun as CrawlRun;
  }

  return { run, emit, recordItemOutcome, recordUnhandledError, setTotalCamps, finish };
}
