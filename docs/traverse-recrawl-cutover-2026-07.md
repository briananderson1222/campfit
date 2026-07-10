# Traverse re-crawl cutover (2026-07)

This is campfit's record of migrating the five admin re-crawl surfaces (camp page,
provider page, bulk crawl-start modal, onboard-a-new-site flow, AI-assistant tool-call)
off the hand-rolled `extractCampDataFromUrl`/`buildPrompt` extraction path and onto the
`@kontourai/traverse`-backed pipeline already used by `scripts/scrape.ts`. It mirrors
`docs/survey-1.x-migration.md`'s adoption-scorecard/plan-gaps structure and
`docs/cutover-report-2026-07.md`'s before/after field-coverage table structure. Session
artifact: `.kontourai/flow-agents/traverse-recrawl-cutover/traverse-recrawl-cutover--deliver.md`
(local-only, gitignored per this repo's convention — not linked as a public URL).

## Summary

`runCrawlPipeline` (`lib/ingestion/crawl-pipeline.ts`) is the single shared implementation
behind all five listed re-crawl call sites, plus two more the issue text didn't name
(`scripts/run-crawl.ts`, `scripts/harvest-aggregator.ts`). The cutover therefore did **not**
rewrite five route files — it swapped `runCrawlPipeline`'s internal extraction step
(previously the retired `extractCampDataFromUrl`) for a new per-camp traverse adapter
(`lib/ingestion/traverse-recrawl-adapter.ts`), while keeping `runCrawlPipeline`'s public
`CrawlOptions -> CrawlRun` signature byte-identical. That one change migrates all five
routes and both scripts in one place.

**`crawl-pipeline.ts` survives, is not deleted** — this is a deliberate deviation from a
literal reading of "DELETE crawl-pipeline.ts if nothing else consumes it." Once the two
script consumers are counted, that conditional resolves to false: deleting the file would
silently orphan `npm run crawl` and `npm run harvest`. `crawl-pipeline.ts`'s internals were
rewritten (extraction call site + a small result-shape adapter); everything else — domain
grouping/`Semaphore` concurrency, the discovery pre-pass, `matchOrCreateProvider`,
`createCrawlRun`/`updateCrawlRunProgress`/`completeCrawlRun`/`appendCrawlLog`/`appendCrawlError`
progress-event plumbing, and `recordExtractionMetrics` — is unchanged.

## Field-parity — before vs after

Traverse's `CAMP_TARGET_SCHEMA` (`lib/ingestion/traverse-schema.ts`), built originally for
`scripts/scrape.ts`'s new-camp/listing-source case, covered 9 scalars and 0 enum-array
families. The legacy `buildPrompt`-driven extractor (retired `lib/ingestion/llm-extractor.ts`
+ `lib/ingestion/llm-provider.ts`'s retired `buildPrompt`) covered 19 scalars plus 2
enum-array fields (`campTypes`, `categories`). Wave 1 (Task 1.1) closed that gap:

| | Scalars | Enum-array families |
| --- | --- | --- |
| Before (pre-cutover traverse schema) | 9 | 0 |
| After (this cutover) | 19 | 2 |

The 10 added scalars: `organizationName`, `registrationOpenDate`, `registrationCloseDate`,
`lunchIncluded`, `contactEmail`, `contactPhone`, `socialLinks`, `interestingDetails`, `state`,
`zip` — matching `lib/ingestion/diff-engine.ts`'s `SCALAR_FIELDS` exactly. The 2 enum-array
families (`campTypes[]`, `categories[]`) are new per-item list-of-enum-string schema entries,
distinct from the pre-existing nested-ROW families (`ageGroups`, `schedules`, `pricing`).
Verified via a new fixture (`tests/fixtures/traverse/avid4-full-fields.html`) and a new
`test:traverse-replay` assertion proving all 10 new scalars and both enum-array families
extract; the pre-existing 3 fixtures/9 assertions were unaffected (replay stayed green
throughout, 10/10 assertions post-Wave-1).

**Known asymmetry — `category` (pre-existing, not introduced by this cutover):**
`traverse-schema.ts`'s `SCALAR_SCHEMA_PATHS` includes `items[].category` (one of the
original 9 pre-cutover scalars, not one of the 10 added above), but `diff-engine.ts`'s
`SCALAR_FIELDS` has no `category` entry — only the plural `categories` enum-array. That means
`category` is extracted by traverse and passed through `assembledItemToDiffInputs()`, but
`computeDiff` silently ignores it: it can never produce a proposal. This is genuinely
pre-existing (the retired `buildPrompt` prompt schema, per `origin/main`'s
`lib/ingestion/llm-provider.ts`, never requested a singular `category` field either — only
`categories`), so it's deliberately left unchanged by this cutover, matching legacy behavior
exactly. It is not full field-schema/diff-field sync — `category` is the one exception — and
is tracked as a candidate follow-up (either add `category` to `SCALAR_FIELDS` if it should be
diffable, or drop `items[].category` from the schema so the model isn't asked to extract a
field whose output is provably discarded).

## Diff-logic reuse (AC6) — `computeDiff`, not `itemToProposedChanges`

`traverse-extractor.ts`'s `itemToProposedChanges` (built for `scripts/scrape.ts`'s
create-if-new, no-history case) has no confidence floor, no review-fatigue suppression, and
no additive-vs-replace array detection. `diff-engine.ts`'s `computeDiff` has all three and is
the primitive every re-crawl route actually needs, since re-crawling an already-reviewed camp
hits the 30-day/0.8-confidence suppression path routinely (a field a human just approved
should not be re-proposed on a low-confidence re-extraction). `lib/ingestion/traverse-recrawl-adapter.ts`
calls the real, unmodified `computeDiff` directly against the matched item's extracted values —
it does not go through `itemToProposedChanges` at all. Proven by
`scripts/test-recrawl-adapter.ts`'s suppression test: a field approved 10 days ago is
suppressed when re-proposed at confidence 0.5, and is NOT suppressed (still proposed) when
re-proposed at confidence 0.95 — proving this isn't an accidental blanket block on the field.

### Local comparison kernel and intentionally separate policies (campfit#108)

The two proposal paths now share a pure, local comparison/provenance seam in
`lib/ingestion/diff-kernel.ts`, without collapsing their intentionally different policies:

- Re-crawl `computeDiff` still owns its field families, `0.3` confidence floor, recent-
  approval suppression, empty-candidate rules, and `populate`/`update`/`add_items` choice.
- First-pass `itemToProposedChanges` still has no confidence floor or recent-approval
  suppression. Present relation arrays still emit `old: null` with `mode: "add_items"`
  without comparing current relations.

The kernel owns only deterministic scalar and order-insensitive outer-array comparison,
exact old/new change records, structural relation facts, and provenance projection. This is
a local seam for possible future extraction; campfit#108 does **not** extract it to Lookout
or create a shared package.

For re-crawl relation arrays, `add_items` now means all of the following: current items are
non-empty, every current item is retained under the existing stable structural identity,
the candidate count grows, and at least one candidate is genuinely novel. Consequently,
retention uses multiset counts: `[A, A] -> [A, B, C]` is an `update`, while
`[A, A] -> [A, A, B]` is `add_items`. Duplicate-only growth such as `[A] -> [A, A]` is an
`update`, while shape-matched `[A] -> [A, B]` remains `add_items`; replacements/removals remain
`update`, empty current remains `populate`, and pure reorder remains a no-op.

That additive classification is currently reachable only for callers that supply shape-matched
current relations. The canonical crawl pipeline does not: it clears current relation arrays before
diffing, which produces `populate`, and Traverse extracts id-less relation objects while stored
relations are id-bearing, which produces `update` when real stored relations are supplied. The
production-shape characterization fixtures pin both behaviors honestly. campfit#109 owns making
relation additive classification reachable through the canonical pipeline; campfit#108 does not
change pipeline behavior or the existing whole-object identity semantics.

The legacy JavaScript crawl runner has been deleted. Repository and owner-reported
out-of-repository scheduler scans found no consumers, and the legacy file contained no unique
fixtures to migrate. Canonical crawl commands use `npm run crawl`, backed by
`scripts/run-crawl.ts` and `runCrawlPipeline`; provider-scoped crawling remains available as
`npm run crawl -- --provider <providerId>`. Obsolete hand-prompt, direct-fetch, API-key
fallback, local-diff, and direct-SQL behavior was intentionally not moved to the canonical
path.

One known runner difference is deliberately out of scope: canonical `scripts/run-crawl.ts`
currently exits before fetch for `--dry-run`, whereas the legacy runner's dry run fetches
pages and skips LLM/database writes. campfit#108 does not redefine canonical dry-run
semantics.

## Per-camp targeting (Stop-short risk 5) — never a name-keyed whole-DB match

Traverse's `currentByItemNames` (built for "does a camp with this extracted name already
exist anywhere," i.e. create-if-new) is the WRONG lookup for "diff against the ONE camp I was
asked to re-crawl" — a shared listing/domain page could otherwise match (and silently
overwrite) an unrelated camp by name collision. `traverse-recrawl-adapter.ts` never uses it.
Instead:

- **0 items** on the fetched page -> fails as `traverse-recrawl:no-items` (a per-camp
  extraction failure, mirroring the legacy error path).
- **1 item** -> unambiguous; assumed to be about the requested camp (mirrors the retired
  legacy per-camp extractor's behavior, which had no multi-item concept at all).
- **>1 items** (shared listing page) -> matched by normalized-name equality against the
  KNOWN camp's OWN name (a local, single-page comparison — never a whole-DB lookup).
  Exactly one match wins; zero or multiple matches fail loudly as
  `traverse-recrawl:ambiguous-multi-item` rather than guessing and risking a wrong-camp write.

This adapter never creates a new `Camp` row and never routes to more than the one target
camp — that behavior belongs only to `onboard-url`. Covered by
`scripts/test-recrawl-adapter.ts` tests 1-3.

## Site-hints wiring (AC7)

`Task 1.2` added an optional per-call hints-merge seam — `TraversePipelineDeps.extraFieldHints`
(`traverse-pipeline.ts`) / `RunTraverseExtractionOptions.extraFieldHints`
(`traverse-extractor.ts`) — so a caller can merge extra field hints into the static
`CAMP_FIELD_HINTS` (`traverse-schema.ts`) for one extraction call, without changing its
default shape for `scripts/scrape.ts`'s existing sources. `crawl-pipeline.ts` still fetches
active `CrawlSiteHint` rows for the target domain (unchanged query, `crawl-pipeline.ts`
pre-extraction step) and passes them to `runTraverseRecrawlForCamp` as `siteHints`; the
adapter renders each freeform hint string under a synthetic `site-hint-<n>` key (these
strings aren't tied to one field path — traverse renders every `fieldHints` entry as a
`- <key>: <hint>` prompt line regardless of whether the key is a real schema path, per
`@kontourai/traverse/anthropic`'s `hintLines` construction, so this is a legitimate, if
unconventional, use of the seam). Verified: `scripts/test-recrawl-adapter.ts` asserts an
injected site hint's text reaches the extraction provider's `fieldHints`, alongside the
static `CAMP_FIELD_HINTS` entries (never replacing them).

### Wave 2 gap (a), closed in Wave 3: the neighborhoods enum-constraint

The Wave 2 rewire of `crawl-pipeline.ts`'s extraction call site dropped a query that no
longer had an obvious home: `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1
ORDER BY name ASC`, which fed the retired `llm-provider.ts` `buildPrompt`'s neighborhood
enum-constraint (`nbhdRule`):

> `- neighborhood must be one of these known Denver neighborhoods or null if not found: <list>`

(captured verbatim before `buildPrompt` was deleted in Task 3.1). This was flagged as an
open gap at the end of Wave 2 rather than silently dropped, and closed here via the same
`extraFieldHints` seam Task 1.2 built for site hints:

- `crawl-pipeline.ts` re-fetches the run's `neighborhoods` (community-scoped, same query,
  same `communitySlug` resolution as before deletion) and passes them to
  `runTraverseRecrawlForCamp` as `TraverseRecrawlOptions.neighborhoods`.
- `traverse-recrawl-adapter.ts`'s new `neighborhoodFieldHint()` renders them as a dedicated
  `items[].neighborhood` field hint — `neighborhood must be one of these known neighborhoods,
  or null if not found: <list>` — mirroring the legacy wording's structure (community-scoped
  rather than Denver-hardcoded, since the adapter itself has no community context; the caller
  supplies whichever community's neighborhoods apply to the target camp). Unlike the generic
  `site-hint-<n>` keys, this uses a real schema-path key since it genuinely constrains one
  field, matching how the static `CAMP_FIELD_HINTS` entries are keyed.
- `buildExtraFieldHints()` merges this alongside any admin site hints — one augments the
  static defaults, never replaces them or the other.

Verified: `scripts/test-recrawl-adapter.ts`'s `testNeighborhoodHintReachesProviderCall` (Wave
2 gap (a) closure test) asserts the `items[].neighborhood` hint reaches the provider's
`fieldHints`, contains every known neighborhood name, matches the legacy wording pattern, and
coexists with an admin site hint passed in the same call.

## Provider/model-choice decision (AC8)

Today's live provider changed from admin-selectable Anthropic/Gemini/Ollama
(the retired `llm-provider.ts` picker) to one datum-resolved provider per process
(`.datum/config.json`'s `extraction-default` role -> `glm-5.2@zai` by default,
`lib/ingestion/resolve-extraction-provider.ts`) — `@kontourai/traverse` ships only an
Anthropic-compatible adapter (`./anthropic` export; no Gemini/Ollama `ExtractionProvider`
exists upstream, and campfit does not fork one in-repo per consume-never-fork, ADR
0008/0010).

**Decision** (Task 1.4): scope `/api/admin/crawl/models` to datum-registered
`anthropic-compatible` models only, read LIVE from `.datum/config.json` via
`@kontourai/datum`'s `loadConfig()`/`describeAuth()`, instead of badging/disabling the old
hardcoded 3-provider list. Reading live means the picker can never drift out of sync with
what `resolveExtractionProvider()` can actually resolve — today that's `.datum/config.json`'s
two registered providers:

| Provider id | Models | Auth env var |
| --- | --- | --- |
| `zai` | `glm-5.2`, `glm-4.6` | `ZAI_API_KEY` |
| `anthropic` | `claude-sonnet-5`, `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |

`app/admin/crawl-modal.tsx`'s picker was updated to badge each option `Key Set`/`No Key`
(via `describeAuth`) and to use an open-ended `provider` id instead of the old fixed 3-way
union — every remaining option now resolves to a real, registered datum provider (the three
never-resolvable Gemini/Ollama entries the legacy hardcoded list carried are gone).

**That endpoint fix alone did not make the picker meaningful for the dominant re-crawl
flow.** `CrawlOptions.model` — the per-run override the five routes/`crawl-modal.tsx` still
POST — is NOT expressible against `resolveExtractionProvider()` as written (it resolves one
process-level provider from datum/`TRAVERSE_ROLE`, with no per-call ref parameter). Rather
than silently dropping the override, `crawl-pipeline.ts` logs one `console.warn` per run and
annotates each camp's `campLog.model` display string with
`[requested override "<model>" not applied — traverse extraction resolves its provider via
datum, not a per-run override]` — the undecorated `extractionModel` column written to
`CampChangeProposal` stays the real, undecorated model id for data integrity. This annotation
is a backstop for API-level callers of the five routes (any caller can still pass `model` in
the request body — it is simply recorded, never silently dropped) and is unchanged by the fix
below. Discovery's `options.model` usage (the legacy `discoverCampsFromUrl` pre-pass, when
`discover: true`) is UNCHANGED and still honors the override — only the traverse-backed
extraction step cannot.

Because `discover` defaults to `false` for every route except onboard-a-new-site (whose flow
doesn't surface this picker at all — it POSTs no `model`/`discover` fields, see the
per-route table below), the model picker being rendered unconditionally in `crawl-modal.tsx`
made it a functional no-op for the common/default admin flow: selecting any model had zero
effect on the crawl that ran, with no indication of that in the UI. An earlier version of
this doc claimed "no option in the picker does nothing when selected" — that was true only in
the narrow endpoint sense (every listed option resolves to a real provider) and did not hold
for the dominant re-crawl path, where no option affected the run at all.

**Fix (iteration 2, 2026-07-03):** `crawl-modal.tsx`'s model picker now renders only when the
"Discover new programs" toggle is on — the one place `options.model` is still honored. It
also carries inline helper text naming the datum-resolved extraction default (read live from
`/api/admin/crawl/models`'s `default` field) and stating plainly that the selection applies to
discovery only and never affects extraction. With the toggle off (the default, and the common
re-crawl path), the picker is not shown at all, so there is no dead or misleading control left
in that flow. Field extraction's provider is, and remains, entirely datum-resolved —
`options.model`/the picker never drive it, in any mode.

## Error-vocabulary parity (AC9)

`app/admin/crawl-failures/crawl-failures-table.tsx`'s `classifyError()` now recognizes two
vocabularies (checked in this order — most specific first):

| Error string prefix / substring | Bucket | Source |
| --- | --- | --- |
| `traverse-recrawl:no-items` | `NO_ITEMS` | adapter item-selection failure |
| `traverse-recrawl:ambiguous-multi-item` | `AMBIGUOUS_MATCH` | adapter item-selection failure |
| `traverse-recrawl:provider-unavailable` | `CONFIG_ERROR` | run-level provider resolution failure (AC13) |
| `http-error: ...` (404) | `MISSING_PAGE` | traverse `FetchErrorKind` |
| `http-error: ...` (401/403/429) | `BLOCKED` | traverse `FetchErrorKind` |
| `http-error: ...` (5xx) | `SERVER_ERROR` | traverse `FetchErrorKind` |
| `http-error: ...` (other) | `HTTP_ERROR` | traverse `FetchErrorKind` |
| `invalid-url:` | `INVALID_URL` | traverse `FetchErrorKind` |
| `invalid-config:` | `CONFIG_ERROR` | traverse `FetchErrorKind` |
| `robots-denied:` | `ROBOTS_BLOCKED` | traverse `FetchErrorKind` |
| `timeout:` | `TIMEOUT` | traverse `FetchErrorKind` |
| `too-many-redirects:` | `TOO_MANY_REDIRECTS` | traverse `FetchErrorKind` |
| `no-snapshot:` | `NO_SNAPSHOT` | traverse `FetchErrorKind` |
| `network:` | `FETCH_FAILURE` | traverse `FetchErrorKind` |
| `http 404` / `http 403` / `http 5xx` | `MISSING_PAGE`/`BLOCKED`/`SERVER_ERROR` | LEGACY (historical rows only) |
| `page text too short` | `JS_OR_THIN_PAGE` | LEGACY (historical rows only) |
| `parse error` | `PARSE_FAILURE` | LEGACY (historical rows only) |
| `fetch failed` | `FETCH_FAILURE` | LEGACY (historical rows only) |
| (anything else) | `OTHER` | fallback |

The LEGACY rows are kept verbatim even though the module that produced them (the retired
per-camp extraction module) is deleted — the STRINGS are already persisted in
`CrawlRun.errorLog`/`campLog` and outlive the code that wrote them; removing the legacy
matchers would silently mis-classify historical failure rows. Each bucket maps to a
triage `recommendation()` string surfaced in the admin UI.

## Per-route parity (AC1, AC10)

| Route | Selection semantics | Discovery? | Model override? | Migration impact |
| --- | --- | --- | --- | --- |
| `app/api/admin/camps/[campId]/crawl/route.ts` | Single known `campId` | No | Yes (not honored for extraction, see AC8) | Per-camp adapter targets that exact `campId` directly |
| `app/api/admin/providers/[providerId]/crawl/route.ts` | All camps for a `providerId` (bulk) | Yes | Yes | Bulk orchestration unchanged; discovery pre-pass stays legacy; per-camp step migrated |
| `app/api/admin/crawl/start/route.ts` | `campIds` array, or all camps missing `websiteUrl` | Yes | Yes | Same bulk path; largest blast radius, most-tested |
| `app/api/admin/crawl/onboard-url/route.ts` | Discovers+creates new camps, then re-crawls only the new `campIds` | Yes (core function) | No | Discovery/creation entirely legacy/unchanged (AC11); only the trailing `runCrawlPipeline` call is migrated |
| `app/api/admin/assistant/route.ts` (`startPipeline`) | Single `campId` OR `providerIds`, AI-assistant tool-call | No | No | Structurally identical to the two dedicated routes; zero route-level change |

All five (plus `scripts/run-crawl.ts` / `scripts/harvest-aggregator.ts`) funnel through the
same `CrawlOptions`/`runCrawlPipeline`; `CrawlOptions`/`CrawlRun` exports are unchanged
(`git diff` on `crawl-pipeline.ts` touches only the internal extraction call site + its
result-shape adapter). Admin polling UI (`recrawl-button.tsx`, `crawl-modal.tsx`,
`app/admin/crawls/page.tsx`) is unaffected — it only ever reads `CrawlRun` fields
(`runId`/`status`/`newProposals`), never the extraction result shape directly.

## Discovery stays on the legacy path (AC11)

`lib/ingestion/llm-discovery.ts` (`discoverCampsFromUrl`/`filterNewDiscoveries`), the
`discover` flag on 3 of the 5 routes, and `onboard-url`'s core discover-then-create flow have
**no traverse equivalent** — traverse has no concept of "detect a listing page and enumerate
programs on it" as a distinct pre-pass from per-item extraction. Migrating discovery is a
separate, larger piece of work, explicitly out of this issue's scope. This is why
`llm-provider.ts` is TRIMMED, not deleted: `callLLM`/`callAnthropic`/`callGemini`/`callOllama`/
`LLMResponse` are kept because `llm-discovery.ts:13` still imports `callLLM` for discovery.
`buildPrompt` and its `DENVER_NEIGHBORHOODS` constant — the extraction-only parts — were
deleted (see "Dead-code closure" below).

## Dead-code closure (AC2, AC3, AC4)

| Item | Disposition |
| --- | --- |
| `lib/ingestion/llm-extractor.ts` | Deleted (whole file — `extractCampDataFromUrl`, `parseExtractionResponse`, `extractJsonObject`, `computeOverallConfidence`) |
| `lib/ingestion/llm-provider.ts`'s `buildPrompt` + `DENVER_NEIGHBORHOODS` | Deleted; `callLLM`/`callAnthropic`/`callGemini`/`callOllama`/`LLMResponse` KEPT for discovery (AC11) |
| `scripts/debug-extract.ts` | **Deleted**, not repointed. Rationale: it was a thin, standalone live-network CLI wrapper (`extractCampDataFromUrl(url, name)` -> print JSON) with no `package.json` script wiring (confirmed: zero `debug-extract` references in `package.json`) and no other consumers. Repointing it at `runTraverseRecrawlForCamp` would require synthesizing a full `Camp` "current" row, a resolved `ExtractionProvider`, and a `SnapshotStore` for a URL with no corresponding DB camp — a meaningfully heavier, DB-shaped tool for what was a one-line debug script. `scripts/test-recrawl-adapter.ts` (network-free, stub provider) and `npm run crawl -- --id <campId>` (live, DB-backed, real provider) already cover the "debug one URL's extraction" need at the two ends of the fidelity spectrum this script sat between. |

Before-count (pre-migration baseline, recorded from planning):
`grep -rn "extractCampDataFromUrl\|parseExtractionResponse\|llm-extractor" . --include="*.ts" --include="*.tsx" --exclude-dir=node_modules --exclude-dir=.next`
returned 6 matches: `scripts/debug-extract.ts:6,11`, `lib/ingestion/crawl-pipeline.ts:2,277`,
`lib/ingestion/llm-extractor.ts:6,91`.

After-count: same grep returns **zero** matches repo-wide. (Prose mentions of the retired
function/file NAMES in migration-context comments were deliberately paraphrased away from the
literal identifier strings so this grep stays a clean zero — see e.g.
`lib/ingestion/traverse-recrawl-adapter.ts`'s file doc, which now says "the retired hand-rolled
per-camp extraction function" instead of spelling the old name.)

`grep -n "buildPrompt\|DENVER_NEIGHBORHOODS" lib/ingestion/llm-provider.ts` returns zero.
`grep -rn "\bcallLLM(" --include="*.ts" --include="*.tsx" .` shows exactly 2 hits: the
definition in `llm-provider.ts` and the one call site in `llm-discovery.ts:90` — confirming
`callLLM` has exactly one surviving consumer family.

## Version bump + cost-guard follow-up (AC12)

`@kontourai/traverse`: `^0.6.0` -> `^0.7.0` (Task 1.5). Re-confirmed at Wave 3 execution time:

```
$ npm view @kontourai/traverse versions --json
[..., "0.5.0", "0.5.1", "0.6.0", "0.7.0"]

$ npm view @kontourai/traverse@0.8.0 version
npm error code E404
npm error 404 No match found for version 0.8.0
```

`@kontourai/traverse@0.8.0` (the cost-guard release — `maxProviderCalls`/`maxTotalTokens`,
traverse#19) is confirmed still unreleased. Adoption is filed as an explicit, non-blocking
**follow-up**: once 0.8.0 ships, wire its cost guards into
`lib/ingestion/resolve-extraction-provider.ts`'s provider construction (and consider whether
`crawl-pipeline.ts`'s per-run provider resolution is the right place for a run-level token/
call budget) — not done here since the package does not yet exist.

## Operational readiness (AC13) — pre-deploy checklist item, not verifiable from this repo

The migrated extraction path's default role (`.datum/config.json`'s `extraction-default` ->
`glm-5.2@zai`) needs `ZAI_API_KEY` in the app's own Vercel serverless environment (or
`TRAVERSE_ROLE=anthropic-default` + `ANTHROPIC_API_KEY` to route around it). Today's legacy
path worked in prod off `ANTHROPIC_API_KEY`/`GEMINI_API_KEY` (confirmed set in `ci.yml`'s
build job); `ZAI_API_KEY` is confirmed present only in `scrape.yml`'s GitHub Actions job env
today (`grep -n "ZAI_API_KEY" .github/workflows/*.yml`) — a **different execution context**
from the app's own serverless functions. This repo/session has no Vercel credential access to
verify or change the app's production env directly (`vercel env ls` fails with "codebase
isn't linked").

**This is a real, unverified gap, not assumed-fine.** Recorded as an explicit pre-deploy
checklist item:

- [ ] Before merging/deploying this migration, confirm `ZAI_API_KEY` (or
      `TRAVERSE_ROLE=anthropic-default` + `ANTHROPIC_API_KEY`) is set in the Vercel project's
      production environment variables for the app's serverless functions specifically — not
      just in the `scrape.yml` GitHub Actions job env, which is a separate execution context.
      Without this, every migrated re-crawl route's extraction step will fail at
      `resolveExtractionProvider()` on first invocation (surfaced cleanly via the
      `traverse-recrawl:provider-unavailable` -> `CONFIG_ERROR` bucket added in this cutover —
      not a silent failure, but still an avoidable production outage if unconfirmed first).

## Test strategy / new coverage (AC14)

`scripts/test-recrawl-adapter.ts` (new, network-free, stub-provider/injected-fetch
convention mirroring `scripts/test-traverse-replay.ts`) is wired into `package.json`'s `lint`
chain as `npm run test:recrawl-adapter`, run after `test:traverse-replay` and before
`eslint .`. 9 assertions:

1. Single-item page targets the known camp directly (with snapshot provenance).
2. Multi-item/shared-listing page matches the known camp by its own name.
3. Multi-item page with no confident name match fails loudly, proposes nothing.
4. AC6: 30-day/0.8-confidence suppression fires on a low-confidence re-proposal of a
   recently-approved field, and does NOT over-suppress a high-confidence one.
5. AC7: admin site hints reach the extraction provider's `fieldHints`.
6. Traverse snapshot provenance is present on a successful result.
7. Wave 2 gap (a) closure: the restored neighborhoods enum-constraint reaches the provider's
   `fieldHints` under `items[].neighborhood`, coexisting with an admin site hint.
8. AC1 structural check: all five named re-crawl routes still import and call the one shared
   `runCrawlPipeline` choke point (read from disk — no DB/network).
9. Five-call-site scenario coverage for the routes' distinct selection semantics (see below).

### Deviation from the plan's Task 3.2 approach: network-free, not live-Postgres

The plan's Task 3.2 described exercising `runCrawlPipeline` end-to-end against the real dev
Postgres, per `verify-admin-platform.ts`'s convention. This worktree has no `.env.local`/
`DATABASE_URL` (confirmed: `scripts/load-env.ts` finds no env file in this working tree — a
separate git worktree from the primary checkout that does have one), so that approach was not
runnable in this environment. Per explicit instruction, the five-call-site coverage stays
network-free instead, split into the structural check (item 8 above, proves AC1's "same 7
call sites still compiling/wired" claim mechanically) and adapter-level scenario coverage
(item 9) for each route's DISTINCT selection semantics:

- `camps/[campId]/crawl` + `assistant`'s `trigger_camp_crawl`: single known campId — covered
  by test 1 (structurally identical call shape; the plan's per-route table already notes
  "zero route-level change expected" for the assistant route).
- `providers/[providerId]/crawl` + `assistant`'s `trigger_provider_crawl`: bulk
  N-camps-sharing-a-domain — covered by test 2 (a shared-listing page, matched by each camp's
  own name).
- `crawl/start`'s `campIds` sweep: multiple UNRELATED camps/domains in one run, isolated from
  each other's outcome — new test, `testCampIdsSweepIsolatesFailures`.
- `crawl/onboard-url`'s trailing re-crawl of a just-created placeholder camp (no
  `fieldSources` history yet) — new test, `testOnboardUrlTrailingRecrawlPopulatesPlaceholderCamp`.

This does not exercise `runCrawlPipeline`'s DB-coupled orchestration (domain grouping,
`CrawlRun` persistence, provider matching) itself — that remains verified only by `next
build`'s typecheck of the unchanged `CrawlOptions`/`CrawlRun` signatures, the structural
route-wiring check above, and (when run in an environment with `DATABASE_URL`) `npm run
verify:admin`. If a future session has DB access in this worktree, promoting this to a live
Postgres smoke per the plan's original Task 3.2 approach remains a reasonable follow-up.

## Accepted gaps summary

| Gap | Status | Where recorded |
| --- | --- | --- |
| Discovery (`llm-discovery.ts`) has no traverse equivalent | Accepted, explicit scope boundary | This doc, AC11 section |
| `@kontourai/traverse` cost guards (0.8.0, unreleased) | Accepted, filed as follow-up | This doc, AC12 section |
| Vercel production `ZAI_API_KEY` provisioning unverifiable from this repo | Accepted, pre-deploy checklist item | This doc, AC13 section |
| Task 3.2's live-Postgres smoke approach not runnable in this worktree | Accepted, network-free coverage substituted | This doc, Test strategy section |

## Cross-references

- Plan: `.kontourai/flow-agents/traverse-recrawl-cutover/traverse-recrawl-cutover--deliver-plan.md`
- Prior traverse migration precedent: `docs/cutover-report-2026-07.md`
- Dependency-bump precedent structure: `docs/survey-1.x-migration.md`
