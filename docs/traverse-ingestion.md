# Traverse ingestion — the full-cutover pipeline (2026-07)

Status: **PRIMARY** — traverse is the only ingestion pipeline. There is no
selector-scraper fallback, no feature flag, and no shadow run. This
supersedes [`docs/traverse-pilot.md`](./traverse-pilot.md) (Slice 1b/2b) and
the `docs/traverse-adjudication-2026-07.md` PILOT-era state; see
[`docs/cutover-report-2026-07.md`](./cutover-report-2026-07.md) for the
before/after cutover measurement.

Package: [`@kontourai/traverse@0.20.0`](https://www.npmjs.com/package/@kontourai/traverse),
with model invocation through `@kontourai/traverse/relay` and fetch/snapshot
support through `@kontourai/traverse/fetch`. The default hosted binding still
resolves through [`@kontourai/datum@0.7.0`](https://www.npmjs.com/package/@kontourai/datum)
and `.datum/config.json`'s `extraction-default` role.

## Pipeline

```
lib/ingestion/sources.ts (INGESTION_SOURCES)
        │
        ▼
lib/ingestion/traverse-pipeline.ts  — fetch (snapshot capture, robots/politeness)
        │                              -> per-item schema-directed extraction
        ▼
lib/ingestion/traverse-item-grouping.ts — group proposals into per-item records
        │                                  via ExtractionProposal.pathIndices
        ▼
lib/ingestion/traverse-extractor.ts — map each item to a ProposedChanges record
        │
        ▼
injected sink (scripts/scrape.ts) — ensure an anchor Camp per item, createProposal
        │
        ▼
Survey review workflow (human review; unchanged)
```

- **`lib/ingestion/sources.ts`** — the source registry (`key`, `name`, `url`).
  No per-source scraping code; every source is fetched + extracted the same way.
- **`lib/ingestion/traverse-schema.ts`** — `CAMP_TARGET_SCHEMA`, the per-item
  schema (`items[].name`, `items[].ageGroups[].minAge`, etc.). Traverse defines
  zero field names itself (ADR 0001) — every path/enum/description is
  caller-owned.
- **`lib/ingestion/traverse-item-grouping.ts`** — `assembleItems()`, the engine
  that regroups a flat `ExtractionProposal[]` back into one record per source
  item using traverse 0.4.0's `pathIndices` (see traverse's ADR 0003). Kills
  cross-band stitching: an item's ages/dates/price come only from its own
  item + sub-item group. Falls back to positional pairing (with a recorded
  warning) when a provider doesn't index a nested array at all — still
  item-scoped, never cross-item.
- **`lib/ingestion/traverse-extractor.ts`** — `itemToProposedChanges()` maps one
  assembled item into CampFit's `ProposedChanges` shape: scalars diffed
  against the current camp value (populate/update), nested arrays
  (`ageGroups`/`schedules`/`pricing`) emitted under their BARE key as a full
  array of reconstructed rows — the shape
  `app/api/admin/review/[id]/approve/route.ts`'s `RELATIONS` handling
  actually applies (the pilot's `"ageGroups[].minAge"`-keyed diffs were
  inert on approve; this isn't).
- **`lib/ingestion/traverse-pipeline.ts`** — `runTraversePipeline()` /
  `runTraversePipelineForSource()`: fetch (`live-with-capture` by default) →
  extract → group → route each item to an injected sink. Never throws;
  per-source failure isolation. Records `tokensUsed` + `latencyMs` per source
  (campfit#39 cost capture).
- **`lib/ingestion/ingestion-runner.ts`** (renamed from `scrape-runner.ts`) —
  `SCRAPE_FAILURE_THRESHOLD` policy: the sweep only exits non-zero when more
  than the threshold fraction of sources failed, or zero succeeded.
- **`lib/ingestion/traverse-snapshot-store.ts`** — the shared filesystem
  snapshot store (`.kontourai/campfit/snapshots/`, gitignored) + honest fetch
  User-Agent. Every live fetch is captured for byte-identical replay.
- **`lib/ingestion/resolve-extraction-provider.ts`** — application-owned Relay
  composition. Datum remains the default hosted model and credential binding;
  `TRAVERSE_RUNTIME_PROFILES` can select the same Traverse definition through
  Claude Code, Codex, OpenCode, or hosted execution. Multiple candidates opt
  into Dispatch fallback, budgets, and optional secret-free receipts.
  `TRAVERSE_MAX_TOKENS` overrides the extraction output token budget (default
  2048 — see the module doc
  for why raising it made glm-5.2-via-Z.AI extraction *worse*, not better).

## Running it

```sh
export ZAI_API_KEY=...          # extraction-default role's key
npm run scrape                   # full sweep, writes CampChangeProposals
npm run scrape:dry                # extract only, no DB write
npx tsx scripts/scrape.ts --source avid4   # single source
```

The extraction definition is independent of where it runs:

```sh
# Use the locally authenticated Codex harness.
TRAVERSE_RUNTIME_PROFILES=codex:gpt-5 npm run scrape:dry

# Ordered fallback; OpenCode prompted JSON requires explicit consent.
TRAVERSE_RUNTIME_PROFILES=claude-code:sonnet,opencode:zai/glm-5 \
TRAVERSE_ALLOW_PROMPTED_STRUCTURED_OUTPUT=true \
TRAVERSE_DISPATCH_RECEIPT_PATH=.kontourai/campfit/dispatch-receipts.ndjson \
npm run scrape:dry
```

The receipt file contains routing outcomes and opaque runtime identifiers, not
source content, prompts, endpoints, or credentials. Without multiple candidates,
an attempt ceiling, or a receipt path, Campfit invokes the selected Relay runtime
directly.

## Rendered (SPA / JS-rendered) provider pages

Some provider pages are client-rendered SPAs whose plain fetch returns an
empty shell. `IngestionSourceConfig.render: true` (`lib/ingestion/sources.ts`)
opts a curated sweep source into `@kontourai/traverse@0.13.0`'s native
rendered-fetch seam; `Provider.requiresRender` (migration 019) does the same
for a provider-triggered per-camp recrawl. Full rationale — the
Vercel-vs-GitHub-Actions execution split, why the seam fails closed on every
Vercel route today, and the operator activation steps for a real SPA
provider — lives in
[`docs/decisions/spa-rendered-provider-pages.md`](./decisions/spa-rendered-provider-pages.md).
An operator flips `requiresRender` on a `Provider` row from that provider's
admin editor page (`app/admin/providers/[providerId]/provider-editor.tsx`,
"Requires Render" toggle); a curated source's `render: true` is a code-level
edit to `lib/ingestion/sources.ts` itself.

## Tests

- `npm run test:traverse-replay` — REPLAY-mode, stub provider, no network/key:
  per-item grouping (incl. a deliberate multi-item + cross-band anti-stitching
  proof), positional-pairing fallback, provenance/warnings, snapshot replay
  determinism, and pipeline-level per-source failure isolation.
- `npm run test:ingestion-runner` — `SCRAPE_FAILURE_THRESHOLD` policy (pure
  logic, no fixtures).
- `npm run test:cutover-baseline` — asserts the committed BEFORE baseline
  (`tests/fixtures/cutover-baseline-2026-07.json`) loads and documents what
  the (now-deleted) legacy scrapers produced live on 2026-07-03.
- `npm run cutover:report` — LIVE (not CI), re-runs the AFTER half of the
  cutover comparison and regenerates `docs/cutover-report-2026-07.md`.
- `npm run test:render-fetch` / `npm run test:shell-detect-retry` — real
  headless-Chromium proof (local fixture server, no network/DB) that a
  rendered fetch recovers content a plain fetch misses, honestly marks
  `Snapshot.rendered: true`, and that the shell-detection auto-retry skips
  (never issues a doomed attempt) when no renderer is configured — see
  `docs/decisions/spa-rendered-provider-pages.md`.

## What was NOT kept

- CSS-selector scrapers (`lib/ingestion/scrapers/avid4.ts`, `denver-arts.ts`)
  and their `BaseScraper`/`scraper-utils.ts` harness.
- The `TRAVERSE_INGESTION` flag and `lib/ingestion/traverse-ingestion.ts`
  (flagged/shadow routing for 2 "rotted" sources only).
- The iD Tech JSON-LD scraper — see `docs/cutover-report-2026-07.md`'s
  disposition section for why it wasn't folded in as a pre-pass (traverse's
  provenance contract strips `<script>` content from the text excerpts are
  verified against, so JSON-LD-sourced values can never pass traverse's own
  normalization without a second, parallel provenance mechanism).
