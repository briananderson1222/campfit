/**
 * crawl-pipeline.ts — THE ONE orchestration seam (campfit#85, WS11 Slice 4).
 *
 * `runCrawlPipeline` is the single exported entry point every crawl trigger
 * funnels through: the five admin re-crawl routes (`camps/[campId]/crawl`,
 * `providers/[providerId]/crawl`, `crawl/start`, `crawl/onboard-url`,
 * `assistant`'s `trigger_camp_crawl`/`trigger_provider_crawl`), the CLI
 * scripts (`scripts/run-crawl.ts`, `scripts/harvest-aggregator.ts`), and — as
 * of Wave 3 below — the source-sweep ingestion path (`scripts/scrape.ts`,
 * `app/api/admin/scrape/route.ts`'s scheduled sweep). Whichever strategy a
 * caller selects, the run-record bookkeeping (CrawlRun creation, live
 * progress/campLog/errorLog writes, final status derivation) goes through
 * ONE shared tracker (`lib/ingestion/crawl-run-tracker.ts`'s `startRun`) —
 * see that module's file doc for the tracker's own contract.
 *
 * Two strategies, one seam:
 *  - **camp strategy** (`CrawlOptions.campIds`/`providerIds`, the original
 *    path): re-crawls known `Camp` rows one at a time, per-domain grouped for
 *    politeness, via `traverse-recrawl-adapter.ts`'s per-camp adapter.
 *  - **sources strategy** (`CrawlOptions.sources`, additive — Wave 3): sweeps
 *    a list of `IngestionSourceConfig` entries (`lib/ingestion/sources.ts`)
 *    via `traverse-pipeline.ts`'s per-source path, anchoring each routed item
 *    to a `Camp` row (mirroring `scripts/scrape.ts`'s prior `ensureAnchorCamp`
 *    convention) and recording its outcome through the SAME tracker the camp
 *    strategy uses — so a source-sweep run gets identical live progress
 *    increments, campLog shape, and FAILED/COMPLETED status derivation, and
 *    never writes the unjoinable `campId: ""` errorLog placeholder the
 *    pre-convergence ad hoc `scrape.ts`/`route.ts` bookkeeping did. The two
 *    strategies are mutually exclusive on one call (fails loudly if both
 *    `sources` and `campIds`/`providerIds` are set) — this is what #92
 *    (scheduled crawls) is expected to call with its own stale/never-crawled
 *    selection layered on top of `campIds`/`providerIds`/`limit`, or with a
 *    curated `sources` batch; #92 does not need a new seam, just this one.
 */
import { getPool } from '@/lib/db';
import type { ExtractionProvider } from '@kontourai/traverse';
import type { SnapshotStore } from '@kontourai/traverse/fetch';
import { runTraverseRecrawlForCamp } from './traverse-recrawl-adapter';
import type { TraverseRecrawlResult } from './traverse-recrawl-adapter';
import { resolveExtractionProvider } from './resolve-extraction-provider';
import { createCampfitSnapshotStore } from './traverse-snapshot-store';
import { startRun } from './crawl-run-tracker';
import { createProposal } from '@/lib/admin/review-repository';
import { recordExtractionMetrics } from '@/lib/admin/metrics-repository';
import { discoverCampsFromUrl, filterNewDiscoveries } from './llm-discovery';
import type { CrawlProgressEvent, CrawlRun, LLMExtractionResult } from '@/lib/admin/types';
import type { Camp } from '@/lib/types';
import { runTraversePipelineForSource } from './traverse-pipeline';
import type { TraverseProposalSink, TraversePipelineDeps, TraversePipelineSourceResult } from './traverse-pipeline';
import type { IngestionSourceConfig } from './sources';
import { slugify } from './slug';

// ── Provider matching helpers ──────────────────────────────────────────────────

function parseDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function domainToName(domain: string): string {
  const base = domain.split('.')[0];
  return base
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function makeUniqueSlug(pool: import('pg').Pool, name: string): Promise<string> {
  const base = toSlug(name);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}

/**
 * For a successfully-crawled camp, ensure it's linked to a Provider.
 * Matches by domain first; creates a new Provider if none exists.
 * No-ops if the camp already has a providerId.
 * Returns a short status string for logging.
 */
async function matchOrCreateProvider(
  pool: import('pg').Pool,
  camp: { id: string; websiteUrl: string; communitySlug: string; city: string | null; providerId: string | null; organizationName?: string | null }
): Promise<string | null> {
  if (camp.providerId) return null; // already linked

  const domain = parseDomain(camp.websiteUrl);
  if (!domain) return null;

  // Find existing provider by domain
  const { rows: existing } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "Provider" WHERE domain = $1 LIMIT 1`,
    [domain]
  );

  let providerId: string;
  let action: string;

  if (existing.length > 0) {
    providerId = existing[0].id;
    action = `matched → ${existing[0].name}`;
  } else {
    const name = camp.organizationName?.trim() || domainToName(domain);
    const slug = await makeUniqueSlug(pool, name);
    const { rows: [created] } = await pool.query<{ id: string }>(
      `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, city, "communitySlug")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain, "updatedAt" = now()
       RETURNING id`,
      [name, slug, camp.websiteUrl, domain, camp.city, camp.communitySlug]
    );
    providerId = created.id;
    action = `created → ${name}`;
  }

  await pool.query(
    `UPDATE "Camp" SET "providerId" = $1 WHERE id = $2 AND "providerId" IS NULL`,
    [providerId, camp.id]
  );

  return action;
}

// ── Source-sweep sink helpers (campfit#85 Wave 3 additive strategy) ────────
//
// `ensureAnchorCamp` mirrors `scripts/scrape.ts`'s prior per-item anchor-camp
// convention EXACTLY (same `slugify` keying, same placeholder Camp shape) —
// moved here so the sources strategy below can route each traverse-extracted
// item to a real, joinable campId the same way the pre-convergence scripts
// did it themselves. Wave 4 deletes the now-duplicate copies in
// `scripts/scrape.ts`/`app/api/admin/scrape/route.ts` once those callers stop
// hand-rolling this and call `runCrawlPipeline({ sources, ... })` instead.
async function ensureAnchorCamp(
  pool: import('pg').Pool,
  itemName: string,
  sourceUrl: string
): Promise<string> {
  const slug = slugify(itemName) || `item-${Date.now()}`;

  const existing = await pool.query<{ id: string }>(`SELECT id FROM "Camp" WHERE slug = $1`, [slug]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (
       id, slug, name, description, notes, "campType", category, "websiteUrl",
       "interestingDetails", city, neighborhood, address, "lunchIncluded",
       "registrationStatus", "sourceType", "sourceUrl", "dataConfidence", "lastVerifiedAt"
     ) VALUES (
       gen_random_uuid()::text, $1, $2, '', NULL, 'SUMMER_DAY'::"CampType",
       'OTHER'::"CampCategory", $3, NULL, '', '', '', false,
       'UNKNOWN'::"RegistrationStatus", 'SCRAPER'::"SourceType", $3,
       'PLACEHOLDER'::"DataConfidence", NOW()
     )
     RETURNING id`,
    [slug, itemName, sourceUrl]
  );
  return inserted.rows[0].id;
}

/**
 * Well-defined, non-blank identifier used for a source-sweep run-record entry
 * recorded BEFORE any campId could be resolved — a whole-source fetch/
 * extraction failure (no item was ever grouped to anchor a camp for), a
 * source page that grouped zero items, or a provider-init failure. Replaces
 * the pre-convergence `campId: ""` placeholder (`scripts/scrape.ts`/
 * `app/api/admin/scrape/route.ts`'s prior inline `errorLog` mapping) — never
 * blank, always traceable back to the source key that produced it.
 *
 * campfit#85 Wave 5 decision (recorded here, not just in the deliver
 * artifact): this identifier is INTENTIONALLY never made joinable to a real
 * `Camp` row — manufacturing a placeholder `Camp` for a source that failed
 * before any item existed would violate `scripts/scrape.ts`'s pre-existing
 * "don't create camps you're not going to route items to" discipline (the
 * plan's option (a)). Instead this is option (b): `getUncrawlableCamps`
 * (`lib/admin/crawl-failure-repository.ts`) keeps its existing `JOIN "Camp"`
 * unchanged (a `source:<sourceKey>` value simply never matches any Camp row,
 * by design) and a SEPARATE, explicitly-labeled query —
 * `getUnassignedSourceFailures`, same file — surfaces exactly this family of
 * errorLog entries instead, so a source-sweep failure is documented and
 * queryable, never silently dropped the way the pre-convergence `campId: ""`
 * placeholder made it (verified by
 * `tests/integration/crawl-orchestrator-run-records.test.ts`).
 */
function sourceFailureCampId(sourceKey: string): string {
  return `source:${sourceKey}`;
}

// ── Traverse extraction shape adapters (Wave 2 rewire) ─────────────────────────
//
// `runTraverseRecrawlForCamp` (traverse-recrawl-adapter.ts) already runs
// `computeDiff` internally and hands back `ProposedChanges` directly — see
// that module's `TraverseRecrawlResult` doc for the shape-adapter contract
// this consumes (skip the old inline `computeDiff`/`JSON.parse` steps; use
// `result.proposedChanges`/`result.rawExtraction` as-is).

/**
 * `recordExtractionMetrics` (lib/admin/metrics-repository.ts) is typed to the
 * legacy `LLMExtractionResult` shape — kept as-is per plan scope (the metrics
 * table/dashboard is unchanged). This adapts one `TraverseRecrawlResult` into
 * just enough of that shape for the metrics it actually reads
 * (`confidence`, `overallConfidence`, `error`, `tokensUsed`, `providerCalls`)
 * — `extracted`/`excerpts`/`rawResponse`/`extractedAt` are not read by
 * `recordExtractionMetrics` and are filled with inert placeholders.
 * `tokensUsed`/`providerCalls` are traverse 0.8.0's
 * `totalTokensUsed`/`providerCalls` (already summed/counted across every
 * chunk's provider call by `runTraverseRecrawlForCamp` — see
 * `TraverseRecrawlResult`'s doc), passed straight through, never re-derived
 * here. `warnings` is likewise passed straight through (non-empty only) so a
 * cost-guard ceiling stop is no longer silently dropped on this shape
 * (campfit#71 code review) — no consumer of `LLMExtractionResult` reads it
 * today, but it now rides along wherever this result is persisted/read
 * instead of being discarded at this adapter boundary. Exported (not just
 * used internally) so `scripts/test-traverse-cost-guards.ts` can assert this
 * shim's shape directly, network-free.
 */
export function toLegacyMetricsResult(result: TraverseRecrawlResult): LLMExtractionResult {
  const confidence: Record<string, number> = {};
  for (const [field, diff] of Object.entries(result.proposedChanges)) {
    confidence[field] = diff.confidence;
  }
  return {
    extracted: {},
    confidence,
    excerpts: {},
    overallConfidence: result.overallConfidence,
    rawResponse: '',
    model: result.model,
    tokensUsed: result.tokensUsed ?? 0,
    providerCalls: result.providerCalls,
    extractedAt: new Date().toISOString(),
    ...(result.error ? { error: result.error } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

/**
 * Synthetic per-camp failure used when the run-level extraction provider
 * failed to resolve (see `providerInitError` below) — every camp in the run
 * gets the SAME clearly-tagged failure via the normal per-camp error path,
 * instead of the whole run crashing before any `CrawlRun`/`campLog` record
 * exists. `traverse-recrawl:provider-unavailable:` follows
 * traverse-recrawl-adapter.ts's own `traverse-recrawl:<reason>:` vocabulary
 * so `crawl-failures-table.tsx`'s classifier (Task 2.2) recognizes it.
 */
function providerUnavailableResult(error: string): TraverseRecrawlResult {
  return {
    ok: false,
    error,
    proposedChanges: {},
    overallConfidence: 0,
    model: 'traverse:unavailable',
    rawExtraction: { via: 'traverse-recrawl', error },
    matchedItemName: null,
    itemCount: 0,
    snapshot: { ref: null, bodyHash: null },
    tokensUsed: null,
    providerCalls: 0,
    latencyMs: 0,
    warnings: [],
  };
}

/**
 * Provider/model-choice decision (traverse-recrawl-cutover plan, AC8; Task
 * 1.4's `models/route.ts`/`crawl-modal.tsx` rewrite already scopes the admin
 * model picker to datum-registered models). `CrawlOptions.model` — the
 * per-run override `crawl-modal.tsx`/the five routes post — is NOT expressible
 * against `resolveExtractionProvider()` as written (it resolves a single
 * process-level provider from `TRAVERSE_ROLE`/datum config, with no per-call
 * ref parameter). Rather than silently dropping the override, this is
 * recorded in the run's `campLog` (see `withModelOverrideNote` below) and
 * logged once here for operators. Discovery's `options.model` usage (the
 * pre-pass below, `discoverCampsFromUrl`) is UNCHANGED and still honors it —
 * only the traverse-backed extraction step cannot.
 */
function warnModelOverrideIgnored(model: string | undefined): void {
  if (!model) return;
  console.warn(
    `[crawl] model override '${model}' requested but traverse-backed extraction resolves its provider from datum (.datum/config.json via resolve-extraction-provider.ts), not a per-run override — the override is NOT applied to extraction (discovery, if enabled, still honors it). Recorded on each camp's crawl-log entry.`
  );
}

/** Appends a note to a camp-log-display model string when a per-run override was requested but couldn't be honored (see `warnModelOverrideIgnored`). Only decorates the human-readable `campLog` display field — `extractionModel` written to `CampChangeProposal` stays the real, undecorated model id. */
function withModelOverrideNote(model: string, requestedOverride: string | undefined): string {
  if (!requestedOverride) return model;
  return `${model} [requested override "${requestedOverride}" not applied — traverse extraction resolves its provider via datum, not a per-run override]`;
}

// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  private slots: number;
  private queue: (() => void)[] = [];
  constructor(concurrency: number) { this.slots = concurrency; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      if (this.slots > 0) { this.slots--; resolve(); }
      else this.queue.push(resolve);
    });
    try { return await fn(); }
    finally {
      if (this.queue.length > 0) this.queue.shift()!();
      else this.slots++;
    }
  }
}

export interface CrawlOptions {
  triggeredBy: string;
  trigger?: 'MANUAL' | 'SCHEDULED';
  campIds?: string[];
  providerIds?: string[];  // crawl all camps for these providers
  providerDiscoveryRoots?: Record<string, string>;
  limit?: number;
  model?: string;
  concurrency?: number;  // max simultaneous domains being crawled (default 3)
  discover?: boolean;    // run discovery pre-pass on listing pages
  onProgress?: (event: CrawlProgressEvent) => void | Promise<void>;
  /**
   * Additive source-sweep strategy (campfit#85 Wave 3) — mutually exclusive
   * with `campIds`/`providerIds` on one call (fails loudly if both are set,
   * per standing directive 1: no silent "one wins" fallback). When set,
   * `runCrawlPipeline` sweeps every configured `IngestionSourceConfig`
   * (`lib/ingestion/sources.ts`) through `traverse-pipeline.ts`'s per-source
   * path instead of re-crawling known camps, routing each extracted item to
   * an anchor `Camp` row through the SAME tracker the camp strategy uses.
   * This is the seam `scripts/scrape.ts`/`app/api/admin/scrape/route.ts` are
   * converged onto in Wave 4 — see the file doc above.
   */
  sources?: IngestionSourceConfig[];
  /**
   * Per-source current-value resolver, forwarded as-is to
   * `traverse-pipeline.ts`'s `TraversePipelineDeps.currentByItemNames` for
   * the sources strategy's scalar populate-vs-update diffing (mirrors
   * `scripts/scrape.ts`'s prior `lookupCurrentBySlug` wiring). Ignored by the
   * camp strategy.
   */
  currentByItemNames?: TraversePipelineDeps['currentByItemNames'];
  /**
   * Optional per-source raw-result observer for the `sources` strategy
   * (campfit#85 Wave 4) — invoked once per source immediately after
   * `traverse-pipeline.ts`'s `runTraversePipelineForSource` resolves (before
   * this function evaluates that result for the shared tracker). Exists so a
   * caller that needs the full `TraversePipelineSourceResult` shape (e.g.
   * `scripts/scrape.ts`'s pre-existing per-source ingestion report —
   * `toIngestionReportEntry`/`summarizeReport`/`printReport` in
   * `lib/ingestion/ingestion-runner.ts` — or `app/api/admin/scrape/route.ts`'s
   * response body) can still build one without `runCrawlPipeline` itself
   * returning the raw array (its return type stays `Promise<CrawlRun>` for
   * both strategies — see the file doc's "one seam" framing). Ignored by the
   * camp strategy. NOT invoked for a source skipped because the whole
   * sweep's extraction provider never resolved (`providerInitError`) — there
   * is no `TraversePipelineSourceResult` to hand back in that case (see the
   * `recordUnhandledError` call in that branch below instead).
   */
  onSourceResult?: (result: TraversePipelineSourceResult) => void | Promise<void>;
}

export async function runCrawlPipeline(options: CrawlOptions): Promise<CrawlRun> {
  if (options.sources?.length) {
    if (options.campIds?.length || options.providerIds?.length) {
      throw new Error(
        '[crawl] CrawlOptions.sources is mutually exclusive with campIds/providerIds on one runCrawlPipeline call — pass exactly one crawl strategy.'
      );
    }
    return runSourceSweepStrategy(options.sources, options);
  }

  const pool = getPool();

  // Resolve campIds from providerIds if provided
  let resolvedCampIds = options.campIds;
  if (!resolvedCampIds?.length && options.providerIds?.length) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "Camp" WHERE "providerId" = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`,
      [options.providerIds]
    );
    resolvedCampIds = rows.map(r => r.id);
  }

  // Fetch camps to crawl (scalar fields only — array relations are fetched separately per camp)
  const campsResult = await pool.query<Camp & { id: string; name: string; websiteUrl: string; communitySlug: string; fieldSources: Record<string, { approvedAt?: string }> }>(
    resolvedCampIds?.length
      ? `SELECT id, name, slug, "websiteUrl", "communitySlug", neighborhood, city, description,
               "campType", category, "campTypes", "categories", state, zip,
               "registrationStatus", "registrationOpenDate", "registrationCloseDate", "lunchIncluded",
               address, "applicationUrl", "contactEmail", "contactPhone", "socialLinks",
               "interestingDetails", "providerId", "organizationName",
               COALESCE("fieldSources", '{}') AS "fieldSources"
         FROM "Camp" WHERE id = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`
      : `SELECT id, name, slug, "websiteUrl", "communitySlug", neighborhood, city, description,
               "campType", category, "campTypes", "categories", state, zip,
               "registrationStatus", "registrationOpenDate", "registrationCloseDate", "lunchIncluded",
               address, "applicationUrl", "contactEmail", "contactPhone", "socialLinks",
               "interestingDetails", "providerId", "organizationName",
               COALESCE("fieldSources", '{}') AS "fieldSources"
         FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != '' ORDER BY "lastVerifiedAt" ASC NULLS FIRST${options.limit ? ` LIMIT ${options.limit}` : ''}`,
    resolvedCampIds?.length ? [resolvedCampIds] : []
  );

  // Fetch neighborhoods once for the run (community slug from first camp or
  // default 'denver') — restored Wave 3 gap closure: this feeds the
  // traverse-recrawl-adapter's `neighborhoods` field hint (the retired
  // `llm-provider.ts` buildPrompt's neighborhood enum-constraint), which was
  // dropped along with this query during the Wave 2 extraction-call rewire
  // and is re-wired here through the adapter's `extraFieldHints` seam
  // instead of a hardcoded prompt string.
  const communitySlug = campsResult.rows[0]?.communitySlug ?? 'denver';
  const neighborhoodsResult = await pool.query<{ name: string }>(
    `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1 ORDER BY name ASC`,
    [communitySlug]
  );
  const neighborhoods = neighborhoodsResult.rows.map(r => r.name);

  // Attach empty arrays for relation fields — the diff engine handles missing arrays gracefully
  // (fetching full relations for 158 camps upfront is expensive; we only load them if a diff
  // for that field is detected, which happens in the approve step, not here)
  const camps = campsResult.rows.map(c => ({
    ...c,
    ageGroups: [] as Camp['ageGroups'],
    schedules: [] as Camp['schedules'],
    pricing: [] as Camp['pricing'],
  }));

  // Create + track the crawl run record through the shared tracker (campfit#85
  // Wave 2 extraction — see crawl-run-tracker.ts's file doc for the seam this
  // is part of). `tracker.emit` is the resolved `options.onProgress` (or a
  // no-op), exposed for events (like `camp_processing` below) that aren't
  // tied to a persisted campLog entry.
  const tracker = await startRun({
    triggeredBy: options.triggeredBy,
    trigger: options.trigger,
    campIds: options.campIds,
    totalCamps: camps.length,
    onProgress: options.onProgress,
  });
  const emit = tracker.emit;
  const runId = tracker.run.id;

  // Resolve the traverse extraction provider + snapshot store ONCE for the
  // whole run (a datum-resolved provider is a process-level resource, not a
  // per-camp one — mirrors scripts/scrape.ts's convention). See AC8: this is
  // where the live provider changes from admin-selectable Anthropic/Gemini/
  // Ollama to one datum-resolved provider per process.
  let extractionProvider: ExtractionProvider | null = null;
  let snapshotStore: SnapshotStore | null = null;
  let providerInitError: string | null = null;
  try {
    extractionProvider = resolveExtractionProvider().provider;
    snapshotStore = createCampfitSnapshotStore();
  } catch (err) {
    providerInitError = `traverse-recrawl:provider-unavailable: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[crawl] extraction provider resolution failed — every camp in this run will fail with a config error: ${providerInitError}`);
  }
  warnModelOverrideIgnored(options.model);

  // Local count of items processed (camp-path only) — used solely for the
  // discovery-added-camps `totalCamps` fixup below (the tracker owns its own
  // internal processedCamps/errorCount/newProposals counters for progress
  // persistence/final-status derivation).
  let itemsProcessed = 0;

  // Group camps by domain for politeness (same domain → sequential)
  const domainMap = new Map<string, typeof camps>();
  for (const camp of camps) {
    const host = getSiteHost(camp.websiteUrl);
    if (!domainMap.has(host)) domainMap.set(host, []);
    domainMap.get(host)!.push(camp);
  }

  const concurrency = Math.min(options.concurrency ?? 3, 10);
  const semaphore = new Semaphore(concurrency);

  let globalIndex = 0;

  const providerDiscoveryRoots = options.providerDiscoveryRoots ?? {};
  const domainTasks = Array.from(domainMap.values()).map(domainCamps =>
    semaphore.run(async () => {
      // ── Discovery pre-pass ──────────────────────────────────────────────────
      // Prefer provider-level discovery roots so discovery can start from the site root/listing
      // instead of only from a downstream camp page.
      // Discovery stays on the legacy `discoverCampsFromUrl`/`callLLM` path
      // (traverse-recrawl-cutover plan AC11 — no traverse equivalent for
      // listing-page enumeration); `options.model` is still honored here.
      const providerId = domainCamps[0]?.providerId ?? null;
      const preferredListingUrl = providerId ? providerDiscoveryRoots[providerId] : null;
      if (options.discover === true) {
        const sharedCampUrl = domainCamps.length >= 2 ? domainCamps[0].websiteUrl : null;
        const sharedUrl = sharedCampUrl ? domainCamps.every(c => c.websiteUrl === sharedCampUrl) : false;
        const listingUrl = preferredListingUrl ?? (sharedUrl ? sharedCampUrl : null);
        if (listingUrl) {
          const existingNames = domainCamps.map(c => c.name);
          const discovery = await discoverCampsFromUrl(listingUrl, { model: options.model }).catch(err => {
            console.error(`[crawl] discovery failed for ${listingUrl}:`, err);
            return null;
          });
          if (discovery && !discovery.error && discovery.isListingPage && discovery.stubs.length > 0) {
            const newStubs = filterNewDiscoveries(discovery.stubs, existingNames);
            if (newStubs.length > 0) {
              console.log(`[crawl] discovery found ${newStubs.length} new programs at ${listingUrl}`);
              // Resolve community/provider info from first camp in group
              const refCamp = domainCamps[0] as unknown as { communitySlug: string; city: string | null; providerId: string | null };
              for (const stub of newStubs) {
                try {
                  const campUrl = stub.detailUrl ?? listingUrl;
                  const campSlug = toSlug(stub.name) + '-' + Math.random().toString(36).slice(2, 6);
                  const { rows: [newCamp] } = await pool.query<{ id: string; name: string; websiteUrl: string; communitySlug: string; city: string | null; fieldSources: Record<string, unknown> }>(
                    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", city, "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
                     VALUES ($1, $2, $3, $4, $5, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $6)
                     ON CONFLICT (slug) DO NOTHING
                     RETURNING id, name, "websiteUrl", "communitySlug", city, COALESCE("fieldSources", '{}') AS "fieldSources"`,
                    [stub.name, campSlug, campUrl, refCamp.communitySlug, refCamp.city, refCamp.providerId]
                  );
                  if (newCamp) {
                    console.log(`[crawl] created discovered camp: ${newCamp.name} (${newCamp.id})`);
                    domainCamps.push({
                      ...newCamp,
                      slug: campSlug,
                      neighborhood: null, description: null, campType: null, category: null,
                      registrationStatus: null, registrationOpenDate: null, registrationCloseDate: null, lunchIncluded: null,
                      address: null, applicationUrl: null, contactEmail: null, contactPhone: null, socialLinks: null,
                      interestingDetails: null, providerId: refCamp.providerId,
                      ageGroups: [] as Camp['ageGroups'],
                      schedules: [] as Camp['schedules'],
                      pricing: [] as Camp['pricing'],
                    } as unknown as typeof camps[0]);
                  }
                } catch (err) {
                  console.error(`[crawl] failed to insert discovered camp "${stub.name}":`, err);
                }
              }
            }
          }
        }
      }

      for (let di = 0; di < domainCamps.length; di++) {
        const camp = domainCamps[di];
        const campIndex = globalIndex++;
        await emit({ type: 'camp_processing', campId: camp.id, campName: camp.name, index: campIndex });

        const startMs = Date.now();
        try {
          // Fetch site hints for this domain
          const domain = getSiteHost(camp.websiteUrl).replace(/^www\./, '');
          const hintsResult = await pool.query<{ hint: string }>(
            `SELECT hint FROM "CrawlSiteHint" WHERE domain = $1 AND active = true ORDER BY "createdAt" ASC`,
            [domain]
          );
          const siteHints = hintsResult.rows.map(r => r.hint);

          // Extract + diff — the traverse-backed per-camp adapter
          // (traverse-recrawl-adapter.ts) targets ONLY this camp's own row
          // and already runs `diff-engine.ts`'s `computeDiff` internally
          // (30-day/0.8-confidence suppression via `fieldSources`, confidence
          // floor, additive-vs-replace array detection) — no inline
          // computeDiff/JSON.parse step needed here anymore (Wave 1 Task 1.3
          // / Wave 2 Task 2.1).
          const fieldSources = (camp as unknown as { fieldSources: Record<string, { approvedAt?: string }> }).fieldSources ?? {};
          const result: TraverseRecrawlResult = providerInitError
            ? providerUnavailableResult(providerInitError)
            : await runTraverseRecrawlForCamp({
                campId: camp.id,
                websiteUrl: camp.websiteUrl,
                campName: camp.name,
                current: camp as unknown as Camp,
                fieldSources,
                siteHints,
                neighborhoods,
                provider: extractionProvider!,
                store: snapshotStore!,
                mode: 'live-with-capture',
              });
          const durationMs = Date.now() - startMs;
          const displayModel = withModelOverrideNote(result.model, options.model);

          if (!result.ok) {
            const error = result.error ?? 'traverse-recrawl: unknown extraction failure';
            await tracker.recordItemOutcome({
              status: 'error',
              campId: camp.id, campName: camp.name, url: camp.websiteUrl,
              model: displayModel, durationMs, error,
            });

            // Still record failure metric (shape-adapted — see toLegacyMetricsResult)
            const siteHost = getSiteHost(camp.websiteUrl);
            await recordExtractionMetrics({ runId, campId: camp.id, siteHost, result: toLegacyMetricsResult(result), changesFound: 0, durationMs });
          } else {
            const proposedChanges = result.proposedChanges;
            const changesFound = Object.keys(proposedChanges).length;

            let proposalId: string | null = null;
            let newProposalsDelta: 0 | 1 = 0;
            if (changesFound > 0) {
              proposalId = await createProposal({
                campId: camp.id,
                crawlRunId: runId,
                sourceUrl: camp.websiteUrl,
                rawExtraction: result.rawExtraction,
                proposedChanges,
                overallConfidence: result.overallConfidence,
                extractionModel: result.model,
              });
              newProposalsDelta = 1;
            }

            // Provider matching — ensure camp is linked to a Provider by domain
            const providerAction = await matchOrCreateProvider(pool, {
              id: camp.id,
              websiteUrl: camp.websiteUrl,
              communitySlug: camp.communitySlug,
              city: camp.city ?? null,
              providerId: (camp as unknown as { providerId: string | null }).providerId ?? null,
              organizationName: (camp as any).organizationName ?? null,
            }).catch(err => {
              console.error(`[crawl] provider match failed for camp ${camp.id}:`, err);
              return null;
            });

            // Record metrics (shape-adapted — see toLegacyMetricsResult)
            const siteHost = getSiteHost(camp.websiteUrl);
            await recordExtractionMetrics({ runId, campId: camp.id, siteHost, result: toLegacyMetricsResult(result), changesFound, durationMs });

            await tracker.recordItemOutcome({
              status: changesFound > 0 ? 'ok' : 'no_changes',
              campId: camp.id, campName: camp.name, url: camp.websiteUrl,
              model: displayModel,
              fieldsChanged: Object.keys(proposedChanges),
              durationMs,
              ...(providerAction ? { providerAction } : {}),
              proposalId,
              confidence: result.overallConfidence,
              newProposalsDelta,
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await tracker.recordUnhandledError({ campId: camp.id, campName: camp.name, url: camp.websiteUrl, error });
        }

        itemsProcessed++;

        // Rate limit — be polite to each domain
        if (di < domainCamps.length - 1) await delay(2000);
      }
    })
  );

  await Promise.all(domainTasks);

  // If discovery added new camps, processedCamps > original totalCamps — fix the DB record
  if (itemsProcessed > camps.length) {
    await tracker.setTotalCamps(itemsProcessed);
  }

  return tracker.finish();
}

// ── Source-sweep strategy (campfit#85 Wave 3 additive branch) ──────────────
//
// Mirrors the camp strategy's run-record shape exactly (same tracker, same
// FAILED/COMPLETED derivation, same campLog/errorLog persistence) while
// sweeping `IngestionSourceConfig` entries instead of known `Camp` rows. Per
// the plan (Wave 3 context): avoid inventing a parallel `source_processing`/
// `source_done` progress-event family — the existing camp-shaped events
// (`camp_processing`/`camp_done`/`camp_error`) are reused, with `campId`
// populated from the sink-resolved anchor camp id once an item routes (or
// `sourceFailureCampId` before one exists — see that helper's doc).
//
// Granularity: `totalCamps` starts at `sources.length` (matches
// `scripts/scrape.ts`'s prior convention); a source that fails before any
// item exists, or resolves zero groupable items, counts as ONE processed
// unit against that estimate, while a source that routes N items counts as N
// — so, exactly like the camp strategy's discovery-added-camps fixup,
// `itemsProcessed` can end up above OR below the initial estimate, and is
// corrected via the same `tracker.setTotalCamps` call at the end.
async function runSourceSweepStrategy(
  sources: IngestionSourceConfig[],
  options: CrawlOptions
): Promise<CrawlRun> {
  const pool = getPool();

  const tracker = await startRun({
    triggeredBy: options.triggeredBy,
    trigger: options.trigger,
    totalCamps: sources.length,
    onProgress: options.onProgress,
  });
  const runId = tracker.run.id;

  // Resolve the traverse extraction provider + snapshot store ONCE for the
  // whole sweep — same process-level-resource convention the camp strategy
  // uses (see its own comment above).
  let extractionProvider: ExtractionProvider | null = null;
  let snapshotStore: SnapshotStore | null = null;
  let providerInitError: string | null = null;
  try {
    extractionProvider = resolveExtractionProvider().provider;
    snapshotStore = createCampfitSnapshotStore();
  } catch (err) {
    providerInitError = `traverse-recrawl:provider-unavailable: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[crawl] extraction provider resolution failed — every source in this sweep will fail with a config error: ${providerInitError}`);
  }

  let itemsProcessed = 0;

  for (let index = 0; index < sources.length; index++) {
    const src = sources[index];
    const startMs = Date.now();
    await tracker.emit({ type: 'camp_processing', campId: sourceFailureCampId(src.key), campName: src.name, index });

    try {
      if (providerInitError) {
        // No item was ever identified for this source (the run-level
        // provider never resolved) — recordUnhandledError (errorLog +
        // counters only, no campLog entry), NOT recordItemOutcome, since
        // there is nothing item-shaped to log. Mirrors how a whole-source
        // fetch/extraction failure below is recorded.
        await tracker.recordUnhandledError({
          campId: sourceFailureCampId(src.key), campName: src.name, url: src.url,
          error: providerInitError,
        });
        itemsProcessed++;
        continue;
      }

      // Sink resolves/creates the per-item anchor camp (ensureAnchorCamp,
      // mirroring scripts/scrape.ts's prior convention), persists the
      // proposal, and records the item's outcome through the SAME tracker
      // the camp strategy uses — this is the one place a real, resolved
      // campId becomes available for a routed item.
      const sink: TraverseProposalSink = async (record, meta) => {
        const campId = await ensureAnchorCamp(pool, record.itemName, meta.sourceUrl);
        const proposalId = await createProposal({
          campId,
          crawlRunId: runId,
          sourceUrl: meta.sourceUrl,
          rawExtraction: record.rawExtraction,
          proposedChanges: record.proposedChanges,
          overallConfidence: record.overallConfidence,
          extractionModel: record.extractionModel,
        });
        const changesFound = Object.keys(record.proposedChanges).length;
        await tracker.recordItemOutcome({
          status: changesFound > 0 ? 'ok' : 'no_changes',
          campId, campName: record.itemName, url: meta.sourceUrl,
          model: record.extractionModel,
          fieldsChanged: Object.keys(record.proposedChanges),
          durationMs: Date.now() - startMs,
          proposalId,
          confidence: record.overallConfidence,
          newProposalsDelta: changesFound > 0 ? 1 : 0,
        });
        itemsProcessed++;
        return proposalId;
      };

      const result = await runTraversePipelineForSource(src, {
        provider: extractionProvider!,
        store: snapshotStore!,
        sink,
        mode: 'live-with-capture',
        currentByItemNames: options.currentByItemNames,
      });

      // Hand the raw per-source result to the optional observer BEFORE
      // this function evaluates it for tracker bookkeeping below — see
      // CrawlOptions.onSourceResult's doc for why this exists (Wave 4
      // callers rebuilding their own ingestion report).
      await options.onSourceResult?.(result);

      if (!result.ok) {
        // Whole-source fetch/extraction failure — no item was ever grouped,
        // so no campId was ever resolved. recordUnhandledError (not
        // recordItemOutcome): there is no item to write a campLog entry
        // about, only a real, non-blank source-level identifier for
        // errorLog (never the pre-convergence campId: "" placeholder).
        const error = result.fetchError ?? result.extractionError ?? 'traverse-pipeline: unknown source failure';
        await tracker.recordUnhandledError({
          campId: sourceFailureCampId(src.key), campName: src.name, url: src.url,
          error,
        });
        itemsProcessed++;
      } else if (result.itemCount === 0) {
        // Fetch + extraction both succeeded but the page grouped zero
        // items — nothing to anchor a camp to, but still one processed
        // unit worth recording (not silently dropped).
        await tracker.recordItemOutcome({
          status: 'no_changes',
          campId: sourceFailureCampId(src.key), campName: src.name, url: src.url,
          model: result.model ?? 'unknown', fieldsChanged: [], durationMs: Date.now() - startMs,
          proposalId: null, confidence: 0, newProposalsDelta: 0,
        });
        itemsProcessed++;
      }
      // else: every routed item's outcome was already recorded inside `sink` above.
    } catch (err) {
      // An uncaught exception in this source's processing step (e.g. the
      // sink's ensureAnchorCamp/createProposal calls threw) — mirrors the
      // camp strategy's outer per-camp try/catch exactly.
      const error = err instanceof Error ? err.message : String(err);
      await tracker.recordUnhandledError({
        campId: sourceFailureCampId(src.key), campName: src.name, url: src.url, error,
      });
      itemsProcessed++;
    }
  }

  // Mirrors the camp strategy's discovery-added-camps fixup: correct
  // totalCamps to the real final count whenever it diverges from the
  // initial sources.length estimate (either direction).
  if (itemsProcessed !== sources.length) {
    await tracker.setTotalCamps(itemsProcessed);
  }

  return tracker.finish();
}

function getSiteHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
