---
status: current
subject: SPA Rendered Provider Pages
decided: 2026-07-07
evidence:
  - kind: issue
    ref: https://github.com/briananderson1222/campfit/issues/53
  - kind: doc
    ref: docs/traverse-ingestion.md
  - kind: doc
    ref: lib/ingestion/render-fetch.ts
---
# SPA Rendered Provider Pages

## Decision

A JS-rendered SPA provider page is ingested via `@kontourai/traverse@0.13.0`'s
native rendered-fetch seam — `SourceConfig.render: true` +
`FetchSourceOptions.renderImpl` (traverse issue #41, mirrors that package's
own `docs/decisions/rendered-fetch.md`) — never by faking a `Response` from
rendered HTML the way the pre-migration `lib/ingestion/render-fetch.ts`
(campfit#42) did. The prior approach fetched real content but never marked
the resulting `Snapshot.rendered: true`, since it flowed through the generic
wire-fetch path; the native seam closes that provenance-honesty gap as its
core purpose (issue #53's R3).

## Execution-environment split (why the renderer is wired in only one place)

CampFit's crawl execution splits across two real environments:

- **Vercel serverless routes** (every admin/cron recrawl + sweep route) —
  cannot launch headless Chromium: no browser binary, and Vercel's
  serverless bundle/cold-start budget makes `@sparticuz/chromium` a
  nontrivial, separate adoption not justified for this slice.
- **GitHub Actions** (`.github/workflows/scrape.yml`, weekly cron +
  `workflow_dispatch`) — already provisions
  `npx playwright install --with-deps chromium` for exactly this reason.

`lib/ingestion/render-fetch.ts`'s `createCampfitRenderImpl()` (the real
Playwright `RenderImpl`) is therefore constructed ONLY in
`scripts/scrape.ts` — the one process this repo's GitHub Actions workflow
runs. Every Vercel-route caller of the shared pipeline
(`lib/ingestion/crawl-pipeline.ts`'s `runCrawlPipeline`) leaves
`fetchOptions.renderImpl` unset, deliberately, each with an inline doc note
at its own call site.

## Fail-closed by construction, not by omission

Traverse's own two-key gate makes `SourceConfig.render: true` with no
`FetchSourceOptions.renderImpl` configured a typed, non-throwing
`invalid-config` `FetchError` — never a silent plain fetch, never a crash.
This is what makes the environment split above SAFE: a
`Provider.requiresRender: true` camp recrawled from any Vercel route
(`lib/ingestion/traverse-recrawl-adapter.ts` → `traverse-pipeline.ts`) fails
closed with that typed error, per-source-isolated, exactly like any other
fetch failure this codebase already handles — never a crash, never a
silently-served empty-shell fetch presented as success.

The shell-detection auto-retry (`traverse-pipeline.ts`, closes
kontourai/traverse#11) applies the same discipline: when a page trips the
`js-shell-suspected` heuristic but no `renderImpl` is configured in this run,
the retry is SKIPPED (never attempted) rather than issuing a doomed
`invalid-config` attempt — recorded via
`TraverseShellEscalation.retrySkippedNoRenderer`.

## Landmine fix (byproduct of the migration)

Pre-migration, `lib/ingestion/traverse-pipeline.ts` imported
`render-fetch.ts` (and therefore `@playwright/test`, a `devDependency`)
unconditionally at module scope — and `traverse-pipeline.ts` is reachable
from every Vercel route via `crawl-pipeline.ts`, including the production
cron `/api/cron/crawl`. Migrating to the native seam removed this import
entirely: `traverse-pipeline.ts` now only references the caller-injected
`FetchSourceOptions.renderImpl` type; only `scripts/scrape.ts`'s own import
graph pulls in the Playwright-backed renderer.

## Data model

`Provider.requiresRender` (migration `019_provider_requires_render.sql`) is
the per-provider opt-in for the camp-strategy recrawl path — a boolean,
mirroring traverse's own `SourceConfig.render?: boolean` contract (no second
render strategy exists today, so an enum would be speculative). The 3
curated sweep sources (`lib/ingestion/sources.ts`'s `INGESTION_SOURCES`) use
their own code-level `render: true` flag instead — no DB column needed
there.

**Explicitly out of scope:** `AggregatorSource.requiresRender`. Aggregator
discovery (`runAggregatorDiscovery`) has no GitHub Actions/CLI execution
path at all — it is Vercel-route-only — so there is no way to make a render
flag there fail-closed-and-honest the way the Provider path can. Adding one
would recreate the "flag exists, dead/dangerous" risk this migration was
built to avoid.

## Owner activation item (accepted gap)

No candidate among the 3 curated `INGESTION_SOURCES` (`avid4`,
`denver-art-museum`, `idtech`) fingerprints as an empty-shell SPA today —
confirmed by live raw-fetch fingerprinting during planning (all three return
substantial server-rendered text, no `__NEXT_DATA__`/`id="root"`/`ng-app`
signature). This migration's mechanics are proven end-to-end against the
local fixture server (`scripts/test-render-fetch.ts`,
`scripts/test-shell-detect-retry.ts`) — real Playwright, real headless
Chromium, real `Snapshot.rendered: true` — but issue #53's literal "one
known SPA provider" is not yet identified. **Recorded here as an accepted
gap, not silently substituted**: identifying a real SPA provider and setting
`requiresRender: true` on its `Provider` row (or adding it as a 4th
`IngestionSourceConfig` with `render: true`) is an owner activation item.
