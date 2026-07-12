/**
 * lib/ingestion/aggregator/aggregator-extraction.ts — aggregator discovery
 * orchestration (campfit#93, R1/R2, AC1/AC2): `crawlSource` (bounded,
 * same-host, per-`AggregatorSource` `maxPages`/`maxDepth`) + `extract()`
 * (per page, against `AGGREGATOR_CANDIDATE_TARGET_SCHEMA`) + dedupe + enqueue
 * into the SAME `ProviderCandidate` queue the curated-source discovery lane
 * (I22/#52) already uses.
 *
 * THE REPOSITORY-LEVEL HALF OF AC1's DUAL GATE: `runAggregatorDiscovery`
 * re-reads a FRESH `AggregatorSource` row via `getAggregatorSource` and
 * refuses (throws `AggregatorTosNotApprovedError`) via `canFetchAggregator`
 * BEFORE `crawlSource` (or anything fetch-adjacent) is ever called — it never
 * trusts a caller-supplied row that may be stale. The route-level half (a
 * `409` before this function is even called) lives in the discover route
 * (Wave 4, Task 4.1).
 *
 * Deliberately a NEW sibling to `lib/ingestion/discovery/runner.ts`'s
 * `runDiscovery`, not a modification of it: `runDiscovery` hard-filters on
 * `isDenverMetro(raw.city)`, which doesn't apply to an aggregator candidate's
 * `locale` field — forcing aggregator candidates through that filter would
 * silently drop legitimate candidates whose `locale` string doesn't parse as
 * a recognized Denver-metro city name. This module reuses
 * `classifyCandidate`/`enqueueCandidate`/the dedupe-target loaders directly
 * (never forking dedupe/enqueue logic), only skipping the metro-boundary
 * step that is specific to the curated-source lane.
 *
 * Zero new fetch/retry/politeness/extraction-engine code: `crawlSource`
 * (`@kontourai/traverse/fetch`, 0.11.0) and `extract()` (`@kontourai/traverse`)
 * are reused verbatim, mirroring `lib/ingestion/traverse-pipeline.ts`'s own
 * discipline of never re-implementing fetch/extraction behavior. Per-PAGE
 * failure isolation (a fetch or extraction failure on one crawled page is
 * recorded and the loop continues) mirrors that same file's per-SOURCE
 * isolation discipline, one level down (a "source" here is one aggregator
 * page rather than one configured site).
 */
import type { Pool } from "pg";
import { extract, type ExtractionProvider } from "@kontourai/traverse";
import { crawlSource } from "@kontourai/traverse/fetch";
import { createGuardedTraverseFetchOptions } from "@/lib/security/egress-url-policy";
import type { FetchSourceOptions, SnapshotStore } from "@kontourai/traverse/fetch";

import { getPool } from "@/lib/db";
import { classifyCandidate, normalizeDomain } from "@/lib/ingestion/discovery/dedupe";
import {
  enqueueCandidate,
  ensureProviderCandidateSchema,
  listPendingCandidateDedupeTargets,
  listProviderDedupeTargets,
} from "@/lib/ingestion/discovery/candidate-repository";
import { CAMPFIT_FETCH_USER_AGENT, createCampfitSnapshotStore } from "@/lib/ingestion/traverse-snapshot-store";

import { canFetchAggregator, getAggregatorSource } from "./aggregator-repository";
import { AGGREGATOR_CANDIDATE_FIELD_HINTS, AGGREGATOR_CANDIDATE_TARGET_SCHEMA } from "./aggregator-schema";
import { groupAggregatorCandidates } from "./aggregator-item-grouping";

/**
 * Thrown by {@link runAggregatorDiscovery} when the aggregator's FRESHLY
 * re-read row has no `tosDecision === 'APPROVED'` — thrown, never silently
 * swallowed, so a caller (the discover route) can distinguish this from any
 * other failure and surface it distinctly (409, not 500).
 */
export class AggregatorTosNotApprovedError extends Error {
  constructor(public readonly aggregatorSourceId: string) {
    super(
      `AggregatorSource ${aggregatorSourceId} has no APPROVED ToS decision on file; refusing to fetch it.`,
    );
    this.name = "AggregatorTosNotApprovedError";
  }
}

/** Thrown when the given `aggregatorSourceId` does not exist at all (distinct from an un-approved one). */
export class AggregatorSourceNotFoundError extends Error {
  constructor(public readonly aggregatorSourceId: string) {
    super(`AggregatorSource ${aggregatorSourceId} not found.`);
    this.name = "AggregatorSourceNotFoundError";
  }
}

export interface AggregatorDiscoveryDeps {
  /** the extraction backend — a stub in tests, `resolveExtractionProvider()` live. */
  provider: ExtractionProvider;
  /** snapshot store `crawlSource` persists every fetched page's snapshot to; defaults to the shared campfit filesystem store. */
  store?: SnapshotStore;
  /** injectable fetch/time seams forwarded to every per-page fetch — the SAME seam `lib/ingestion/traverse-pipeline.ts` uses for its own fixture-fetch tests. */
  fetchOptions?: FetchSourceOptions;
  /** live (default) | live-with-capture | replay — same vocabulary as `crawlSource`'s own `CrawlOptions.mode`. */
  mode?: "live" | "live-with-capture" | "replay";
  /** log sink; defaults to console.log. */
  log?: (msg: string) => void;
  /** wall-clock reader (ms), injectable for deterministic `retrievedAt` in tests. */
  now?: () => number;
}

export type AggregatorDiscoveryDisposition =
  | "enqueued-new"
  | "enqueued-near-duplicate"
  | "skipped-duplicate"
  /**
   * campfit#93 M fix: a structural (not prompt-only) backstop that drops any
   * item whose `websiteUrl` domain equals the aggregator's OWN domain —
   * catches the aggregator's own branding/listing slipping through if the
   * extraction provider doesn't fully honor `aggregator-schema.ts`'s
   * "never propose the aggregator itself" field hint.
   */
  | "skipped-self";

export interface AggregatorDiscoveryOutcome {
  /** the source item index on its page (see `groupAggregatorCandidates`). */
  itemIndex: number;
  /** the aggregator page this candidate was drawn from. */
  pageUrl: string;
  name: string;
  websiteUrl: string | null;
  disposition: AggregatorDiscoveryDisposition;
  detail: string | null;
  /** populated for enqueued dispositions. */
  candidateId?: string;
}

export interface AggregatorDiscoveryPageError {
  url: string;
  error: string;
}

/** Mirrors `DiscoverySummary`'s shape (runner.ts), the curated-source lane's own AC1 evidence surface. */
export interface AggregatorDiscoverySummary {
  aggregatorSourceId: string;
  communitySlug: string;
  discoveredPages: number;
  discoveredCandidates: number;
  enqueuedNew: number;
  enqueuedNearDuplicate: number;
  skippedDuplicate: number;
  /** count of items dropped by the structural self-branding backstop (see `"skipped-self"`). */
  skippedSelf: number;
  pageErrors: AggregatorDiscoveryPageError[];
  crawlWarnings: string[];
  truncated: boolean;
  outcomes: AggregatorDiscoveryOutcome[];
}

/**
 * Run one aggregator through crawl + extract + dedupe + enqueue.
 *
 * 1. Re-reads a FRESH `AggregatorSource` row and refuses (throws) before any
 *    fetch when it is not ToS-approved (AC1's repository-level gate).
 * 2. `crawlSource`s the aggregator's `url`, bounded by ITS OWN
 *    `maxPages`/`maxDepth` (never a caller override — the admin who
 *    registered the aggregator set these).
 * 3. For each crawled page that produced a snapshot, `extract()`s against
 *    `AGGREGATOR_CANDIDATE_TARGET_SCHEMA`; a page-level extraction error is
 *    recorded and the loop continues (never throws — per-page isolation).
 * 4. Groups each page's proposals via `groupAggregatorCandidates`, classifies
 *    every named item against onboarded providers + already-queued
 *    candidates (`classifyCandidate`), skips exact duplicates, and
 *    `enqueueCandidate`s new/near-duplicate items with full provenance
 *    (`provenanceExcerpt`/`provenanceLocator` from the item's `name` field,
 *    `snapshotSourceRef` from the page). Folds each enqueued candidate into
 *    the in-run dedupe set so a name repeated across two crawled pages is
 *    caught (mirrors `runner.ts`'s own in-run dedupe fold).
 */
export async function runAggregatorDiscovery(
  aggregatorSourceId: string,
  actor: { performedBy: string },
  deps: AggregatorDiscoveryDeps,
  pool: Pool = getPool(),
): Promise<AggregatorDiscoverySummary> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? (() => Date.now());

  // Never trust a caller-supplied row — always re-read fresh immediately
  // before deciding whether to fetch (AC1's repository-level gate).
  const source = await getAggregatorSource(aggregatorSourceId, pool);
  if (!source) {
    throw new AggregatorSourceNotFoundError(aggregatorSourceId);
  }
  if (!canFetchAggregator(source)) {
    throw new AggregatorTosNotApprovedError(aggregatorSourceId);
  }

  // Idempotent — safe to call even if the additive migration 017 / the
  // ProviderCandidate extension hasn't been applied yet (mirrors
  // runDiscovery's own use of ensureProviderCandidateSchema).
  await ensureProviderCandidateSchema(pool);

  log(
    `[aggregator-extraction] ${source.id} (${source.name}): starting discovery, performed by ${actor.performedBy}`,
  );

  const manifest = await crawlSource(
    { id: source.id, url: source.url, userAgent: CAMPFIT_FETCH_USER_AGENT },
    {
      maxPages: source.maxPages,
      maxDepth: source.maxDepth,
      store: deps.store ?? createCampfitSnapshotStore(),
      mode: deps.mode ?? "live-with-capture",
      fetchOptions: (deps.mode ?? "live-with-capture") === "replay"
        ? deps.fetchOptions
        : createGuardedTraverseFetchOptions(deps.fetchOptions, "discoveredLink"),
    },
  );

  // Dedupe targets loaded once up front, exactly like runner.ts: near-duplicate
  // matching stays against the onboarded-provider snapshot, while exact
  // matching also folds in candidates enqueued earlier in THIS run.
  const providers = await listProviderDedupeTargets(source.communitySlug, pool);
  const queued = await listPendingCandidateDedupeTargets(source.communitySlug, pool);

  // Structural (code-level) backstop for the "never propose the aggregator's
  // own branding as a candidate" guard (campfit#93 M fix): the prompt-only
  // field hint (aggregator-schema.ts) cannot be relied on to hold against a
  // real, non-deterministic extraction backend, so any item whose
  // `websiteUrl` domain equals the aggregator's own domain is dropped here,
  // in code, regardless of what the extraction provider proposed.
  const sourceDomain = normalizeDomain(source.url);

  const summary: AggregatorDiscoverySummary = {
    aggregatorSourceId: source.id,
    communitySlug: source.communitySlug,
    discoveredPages: manifest.pages.length,
    discoveredCandidates: 0,
    enqueuedNew: 0,
    enqueuedNearDuplicate: 0,
    skippedDuplicate: 0,
    skippedSelf: 0,
    pageErrors: [],
    crawlWarnings: manifest.warnings,
    truncated: manifest.truncated,
    outcomes: [],
  };

  for (const page of manifest.pages) {
    if (!page.fetch.snapshot) {
      if (page.fetch.error) {
        summary.pageErrors.push({ url: page.url, error: `${page.fetch.error.kind}: ${page.fetch.error.message}` });
        log(`[aggregator-extraction] ${source.id}: fetch failed for ${page.url} (${page.fetch.error.kind})`);
      }
      continue;
    }

    const snapshot = page.fetch.snapshot;
    const sourceRef = page.sourceRef ?? null;

    const result = await extract({
      content: snapshot.body,
      contentType: snapshot.contentType,
      sourceRef: sourceRef ?? `aggregator:${source.id}:${page.url}`,
      targetSchema: AGGREGATOR_CANDIDATE_TARGET_SCHEMA,
      fieldHints: AGGREGATOR_CANDIDATE_FIELD_HINTS,
      provider: deps.provider,
    });

    if (result.error) {
      summary.pageErrors.push({ url: page.url, error: result.error });
      log(`[aggregator-extraction] ${source.id}: extraction failed for ${page.url} (${result.error})`);
      continue;
    }

    const items = groupAggregatorCandidates(result.proposals);

    for (const item of items) {
      // The schema declares `name` required; an item that never got one from
      // this page's extraction carries nothing worth queuing (mirrors
      // RawProviderCandidate's own requirement that name always be present).
      if (!item.name) continue;

      summary.discoveredCandidates++;

      const websiteUrl = item.websiteUrl?.value ?? null;
      const domain = normalizeDomain(websiteUrl);

      // M fix: structural self-branding backstop — drop before dedupe
      // classification even runs, so the aggregator's own listing can never
      // reach the candidate queue no matter what the extraction provider
      // proposed.
      if (sourceDomain && domain === sourceDomain) {
        summary.skippedSelf++;
        summary.outcomes.push({
          itemIndex: item.itemIndex,
          pageUrl: page.url,
          name: item.name.value,
          websiteUrl,
          disposition: "skipped-self",
          detail: `matches aggregator's own domain (${sourceDomain})`,
        });
        continue;
      }

      const verdict = classifyCandidate({ name: item.name.value, domain }, providers, queued);

      if (verdict.kind === "exact-duplicate") {
        summary.skippedDuplicate++;
        summary.outcomes.push({
          itemIndex: item.itemIndex,
          pageUrl: page.url,
          name: item.name.value,
          websiteUrl,
          disposition: "skipped-duplicate",
          detail: `${verdict.reason} — matches "${verdict.matched.name}"`,
        });
        continue;
      }

      const nearMatch = verdict.kind === "near-duplicate" ? verdict : null;
      const row = await enqueueCandidate(
        {
          name: item.name.value,
          websiteUrl,
          city: null,
          communitySlug: source.communitySlug,
          sourceKey: `aggregator:${source.id}`,
          sourceLabel: source.name,
          discoveryQuery: page.url,
          retrievedAt: new Date(now()),
          locale: item.locale?.value ?? null,
          aggregatorSourceId: source.id,
          provenanceExcerpt: item.name.provenance.excerpt,
          provenanceLocator: item.name.provenance.locator,
          snapshotSourceRef: sourceRef,
          possibleDuplicateOfProviderId: nearMatch ? nearMatch.matched.id : null,
          possibleDuplicateOfName: nearMatch ? nearMatch.matched.name : null,
          duplicateReason: nearMatch ? nearMatch.reason : null,
        },
        pool,
      );

      summary.outcomes.push({
        itemIndex: item.itemIndex,
        pageUrl: page.url,
        name: item.name.value,
        websiteUrl,
        disposition: nearMatch ? "enqueued-near-duplicate" : "enqueued-new",
        detail: nearMatch ? nearMatch.reason : null,
        candidateId: row.id,
      });

      // Fold this candidate into the in-run dedupe set so a later duplicate
      // on the SAME run (a name repeated across two crawled pages) is caught.
      queued.push({ id: row.id, name: item.name.value, domain });

      if (nearMatch) summary.enqueuedNearDuplicate++;
      else summary.enqueuedNew++;
    }
  }

  log(
    `[aggregator-extraction] ${source.id}: ${summary.discoveredPages} page(s), ` +
      `${summary.discoveredCandidates} candidate(s) discovered, ${summary.enqueuedNew} new, ` +
      `${summary.enqueuedNearDuplicate} near-duplicate, ${summary.skippedDuplicate} skipped-duplicate, ` +
      `${summary.skippedSelf} skipped-self, ${summary.pageErrors.length} page error(s)`,
  );

  return summary;
}
