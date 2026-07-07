import { createCrawlRun, updateCrawlRunProgress, completeCrawlRun, appendCrawlError, appendCrawlLog } from '@/lib/admin/crawl-repository';
import type { CrawlProgressEvent, CrawlRun, CrawlCampLogEntry } from '@/lib/admin/types';

/**
 * Shared run-record tracker (campfit#85, WS11 Slice 4, Wave 2; guarded
 * semantics added in the H1 review fix pass).
 *
 * Owns the full `CrawlRun` bookkeeping lifecycle — creation, live
 * progress/campLog/errorLog writes during a run, and final status
 * derivation/completion — so both `runCrawlPipeline` strategies
 * (`lib/ingestion/crawl-pipeline.ts`'s camp-list loop today; the additive
 * source-list strategy landing on the same seam) write through ONE tracker
 * instead of each hand-rolling its own `createCrawlRun`/`appendCrawlLog`/
 * `appendCrawlError`/`updateCrawlRunProgress`/`completeCrawlRun` calls.
 *
 * This is an extraction of what was previously inlined in `runCrawlPipeline`'s
 * per-camp loop — the shape/ordering of every write and every
 * `CrawlProgressEvent` it emits matches what the camp-path loop did before
 * this refactor. It is NOT byte-identical in one deliberate, load-bearing
 * way (campfit#85 code-review finding H1): the pre-refactor loop fired its
 * mid-run progress update as `void updateCrawlRunProgress(...)` — a genuine
 * fire-and-forget write whose failure could never abort the run. Awaiting
 * that write (this module's Wave 2 change, done for ordering determinism —
 * see below) reintroduced a way for a transient bookkeeping-write failure to
 * reject `recordItemOutcome`/`recordUnhandledError` and, via
 * `crawl-pipeline.ts`'s `Promise.all(domainTasks)`, abort the entire run
 * before `finish()` ever ran — silently stranding the `CrawlRun` row at
 * `RUNNING` forever. Fixed here by wrapping every non-essential DB
 * bookkeeping write inside `recordItemOutcome`/`recordUnhandledError`/
 * `setTotalCamps` in a guard (see `guardedWrite` below) that logs a
 * `console.warn` and continues instead of throwing — restoring the original
 * "a bookkeeping write can never abort the run" property while KEEPING the
 * awaited-not-void ordering (each write is still fully applied, in order,
 * before the next one starts — no cross-write races) that the Wave 2
 * refactor was written to guarantee. Only `finish()`'s own
 * `completeCrawlRun` write is left unguarded — same as the pre-refactor
 * code, which never guarded its own final write either.
 *
 * Domain-specific concerns that are NOT part of run-record plumbing —
 * proposal creation (`createProposal`), provider matching
 * (`matchOrCreateProvider`), extraction metrics (`recordExtractionMetrics`)
 * — stay in the calling strategy's own loop; the tracker only ever sees the
 * already-resolved outcome of that domain work.
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
  /** Explicit success/failure outcome — persists campLog (+ errorLog for failures), bumps progress counters, emits `camp_done`/`camp_error`. Never throws — see file doc's guarded-write semantics. */
  recordItemOutcome(outcome: ItemOutcome): Promise<void>;
  /**
   * An uncaught-exception outcome — the item's whole processing step threw
   * before producing a `result.ok`-shaped outcome. Mirrors the outer
   * `catch` in the original per-camp loop exactly: bumps
   * processedCamps/errorCount and the in-memory errorLog buffer (persisted
   * wholesale at `finish()`), emits `camp_error` — but, matching prior
   * behavior, does NOT call `appendCrawlError`/`appendCrawlLog` (no
   * campLog entry exists for a step that threw before producing one). Never
   * throws — see file doc's guarded-write semantics.
   */
  recordUnhandledError(entry: { campId: string; campName: string; url: string; error: string }): Promise<void>;
  /** Corrects `totalCamps` mid/post-run (matches the prior post-loop `processedCamps > camps.length` discovery fixup). Never throws — see file doc's guarded-write semantics. */
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

  /**
   * Runs one non-essential bookkeeping DB write (`appendCrawlError`/
   * `appendCrawlLog`/`updateCrawlRunProgress`) and swallows any failure —
   * logs a `console.warn` (existing `[crawl]`-prefixed convention) and
   * returns instead of rejecting, so a transient write failure can never
   * abort the run or prevent `finish()` from running (campfit#85 review
   * H1). `label`/`campId` are only for the warning message; the in-memory
   * counters (`processedCamps`/`errorCount`/`newProposals`/`errorLog`) this
   * tracker keeps have already been updated by the caller BEFORE this is
   * invoked, so the final `finish()` write (`completeCrawlRun`, which
   * writes the whole `errorLog` wholesale) still reflects the run's true
   * outcome even if a live/incremental write above was dropped.
   */
  async function guardedWrite(label: string, campId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[crawl] run-record bookkeeping write failed (non-fatal, run continues — campfit#85 review H1): ${label} (run ${run.id}, campId ${campId}) — ${message}`);
    }
  }

  async function recordItemOutcome(outcome: ItemOutcome): Promise<void> {
    if (outcome.status === 'error') {
      errorCount++;
      errorLog.push({ campId: outcome.campId, error: outcome.error, url: outcome.url });
      await guardedWrite('appendCrawlError', outcome.campId, () =>
        appendCrawlError(run.id, { campId: outcome.campId, error: outcome.error, url: outcome.url })
      );
      const entry: CrawlCampLogEntry = {
        campId: outcome.campId, campName: outcome.campName, url: outcome.url,
        status: 'error', model: outcome.model,
        proposals: 0, fieldsChanged: [], error: outcome.error,
        durationMs: outcome.durationMs, processedAt: new Date().toISOString(),
      };
      await guardedWrite('appendCrawlLog', outcome.campId, () => appendCrawlLog(run.id, entry));
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
      await guardedWrite('appendCrawlLog', outcome.campId, () => appendCrawlLog(run.id, entry));
      await emit({ type: 'camp_done', campId: outcome.campId, proposalId: outcome.proposalId, confidence: outcome.confidence, changesFound });
    }
    processedCamps++;
    await guardedWrite('updateCrawlRunProgress', outcome.campId, () =>
      updateCrawlRunProgress(run.id, { processedCamps, errorCount, newProposals })
    );
  }

  async function recordUnhandledError(entry: { campId: string; campName: string; url: string; error: string }): Promise<void> {
    errorCount++;
    errorLog.push({ campId: entry.campId, error: entry.error, url: entry.url });
    await emit({ type: 'camp_error', campId: entry.campId, campName: entry.campName, error: entry.error });
    processedCamps++;
    await guardedWrite('updateCrawlRunProgress', entry.campId, () =>
      updateCrawlRunProgress(run.id, { processedCamps, errorCount, newProposals })
    );
  }

  async function setTotalCamps(totalCamps: number): Promise<void> {
    await guardedWrite('updateCrawlRunProgress(totalCamps)', 'n/a', () =>
      updateCrawlRunProgress(run.id, { totalCamps })
    );
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
