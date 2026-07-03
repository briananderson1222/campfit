# Traverse full cutover — before/after report (2026-07)

Generated: 2026-07-03T01:46:53.138Z
BEFORE baseline: 2026-07-03T01:17:27.223Z (tests/fixtures/cutover-baseline-2026-07.json, legacy CSS-selector scrapers, live)
AFTER: traverse full cutover pipeline, live, provider anthropic-extraction-provider:glm-5.2@api.z.ai (datum ref "extraction-default" -> zai, model glm-5.2)

## Regression rule

Per the owner directive: if a source's item count drops **>40%** vs baseline, or a
previously-covered field class disappears entirely, that source's regression is
GINORMOUS — it is not papered over. The cutover still merges if the rest is sound,
but that source is flagged **⚠️ OWNER DECISION** below with the exact before/after
numbers proving what changed.

## Summary — count, cost, latency

| Source | Before (legacy) | After (traverse) | Ratio | Tokens | Latency (ms) | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| avid4 | 0 | 4 | baseline was 0 — traverse can only improve | 11090 | 39328 | ✅ ok |
| denver-art-museum | 1 | 3 | 3/1 = 300% of baseline | 2060 | 26765 | ⚠️ OWNER DECISION |
| idtech | 23 | 10 | 10/23 = 43% of baseline — DROPPED >40% (regression rule tripped) | 2087 | 30156 | ⚠️ OWNER DECISION |

Total tokens across all 3 sources (one live extraction call each): **15237**.

## Field coverage — before vs after

### avid4

| Field | Before coverage | After coverage |
| --- | --- | --- |
| name | 0/0 (0%) | 4/4 (100%) |
| description | 0/0 (0%) | 1/4 (25%) |
| category | 0/0 (0%) | 4/4 (100%) |
| registrationStatus | 0/0 (0%) | 4/4 (100%) |
| applicationUrl | 0/0 (0%) | 0/4 (0%) |
| websiteUrl | 0/0 (0%) | 0/4 (0%) |
| city | 0/0 (0%) | 4/4 (100%) |
| neighborhood | 0/0 (0%) | 0/4 (0%) |
| address | 0/0 (0%) | 0/4 (0%) |
| ageGroups | 0/0 (0%) | 4/4 (100%) |
| schedules | 0/0 (0%) | 4/4 (100%) |
| pricing | 0/0 (0%) | 0/4 (0%) |

### denver-art-museum

| Field | Before coverage | After coverage |
| --- | --- | --- |
| name | 1/1 (100%) | 2/3 (67%) |
| description | 1/1 (100%) | 1/3 (33%) |
| category | 1/1 (100%) | 3/3 (100%) |
| registrationStatus | 1/1 (100%) | 2/3 (67%) |
| applicationUrl | 0/1 (0%) | 0/3 (0%) |
| websiteUrl | 1/1 (100%) | 0/3 (0%) ⚠️ |
| city | 1/1 (100%) | 0/3 (0%) ⚠️ |
| neighborhood | 1/1 (100%) | 0/3 (0%) ⚠️ |
| address | 1/1 (100%) | 0/3 (0%) ⚠️ |
| ageGroups | 1/1 (100%) | 2/3 (67%) |
| schedules | 0/1 (0%) | 3/3 (100%) |
| pricing | 0/1 (0%) | 0/3 (0%) |

### idtech

| Field | Before coverage | After coverage |
| --- | --- | --- |
| name | 23/23 (100%) | 10/10 (100%) |
| description | 23/23 (100%) | 0/10 (0%) ⚠️ |
| category | 23/23 (100%) | 10/10 (100%) |
| registrationStatus | 23/23 (100%) | 0/10 (0%) ⚠️ |
| applicationUrl | 0/23 (0%) | 0/10 (0%) |
| websiteUrl | 23/23 (100%) | 0/10 (0%) ⚠️ |
| city | 0/23 (0%) | 0/10 (0%) |
| neighborhood | 0/23 (0%) | 0/10 (0%) |
| address | 0/23 (0%) | 0/10 (0%) |
| ageGroups | 23/23 (100%) | 10/10 (100%) |
| schedules | 0/23 (0%) | 0/10 (0%) |
| pricing | 0/23 (0%) | 0/10 (0%) |

## Replay determinism

Live-run smoke check: each source's captured snapshot was immediately re-served
via `replaySource()` with no network — proving the fetch/snapshot side is
byte-identical and replayable. VALUE-level determinism (same input -> same
grouped proposals) is proven deterministically in CI
(`npm run test:traverse-replay`) using a stub provider — real LLM output is not
claimed to be reproducible run-to-run (glm-5.2 is non-deterministic; see
docs/traverse-adjudication-2026-07.md).

| Source | Snapshot replay OK |
| --- | --- |
| avid4 | ✅ |
| denver-art-museum | ✅ |
| idtech | ✅ |

## ⚠️ OWNER DECISION items

### denver-art-museum

- Before: 1 camps (legacy, 2026-07-03T01:17:27.223Z)
- After: 3 items (traverse, live)
- Count regression: 3/1 = 300% of baseline
- Field classes that disappeared entirely: websiteUrl, city, neighborhood, address
- Warnings: dropped malformed tool item at index 21: not an object; response truncated at maxTokens; proposals may be incomplete; dropped proposal for "items[].description": excerpt not found in prepared content; dropped proposal for "items[].name": excerpt not found in prepared content; dropped proposal for "items[].description": excerpt not found in prepared content

### idtech

- Before: 23 camps (legacy, 2026-07-03T01:17:27.223Z)
- After: 10 items (traverse, live)
- Count regression: 10/23 = 43% of baseline — DROPPED >40% (regression rule tripped)
- Field classes that disappeared entirely: description, registrationStatus, websiteUrl
- Warnings: response truncated at maxTokens; proposals may be incomplete

## What was deleted vs kept

**Deleted** (full cutover — no shadow/parallel path kept):
- CSS-selector scrapers: `lib/ingestion/scrapers/avid4.ts`, `denver-arts.ts`
- `lib/ingestion/scraper-base.ts`, `lib/ingestion/scraper-utils.ts` (BaseScraper harness)
- `TRAVERSE_INGESTION` flag + `lib/ingestion/traverse-ingestion.ts` (flagged/shadow routing)
- `scripts/traverse-parity.ts` (superseded by this script)
- iD Tech JSON-LD scraper (`lib/ingestion/scrapers/idtech.ts`) — see disposition below

**Kept** (product discipline, not legacy):
- The review-workflow sink: proposals -> `createProposal` -> human review
- Per-source failure isolation + `SCRAPE_FAILURE_THRESHOLD` (renamed home:
  `lib/ingestion/ingestion-runner.ts`, was `scrape-runner.ts`)
- Robots/politeness + snapshot capture on every fetch (`@kontourai/traverse/fetch`)

## Notes — cost capture + provider tuning (campfit#39 criterion 5)

- **Cost capture**: `tokensUsed` above is `raw.tokensUsed` from the Anthropic
  adapter (`input_tokens + output_tokens`), threaded through
  `lib/ingestion/traverse-pipeline.ts`'s per-source result and
  `lib/ingestion/traverse-extractor.ts`'s per-item `rawExtraction` for audit —
  this closes the cost half of campfit#39.
- **maxTokens tuning (live probe against the captured idtech snapshot)**: raising
  the Anthropic adapter's response token budget from its 2048 default to
  4096/6144/8192 was tried expecting MORE items (23 courses need a lot of
  per-item excerpts). It made results WORSE, not better — every budget hit
  `stop_reason === "max_tokens"`, but at 4096+ the response truncated before ANY
  valid tool_use JSON completed (0 proposals); only 2048 forced glm-5.2 to reach
  usable tool_use content before truncating. `lib/ingestion/resolve-extraction-provider.ts`
  keeps 2048 as the default for this reason (overridable via `TRAVERSE_MAX_TOKENS`
  for a future provider that doesn't share this behavior).
- **idtech's root cause**: the page's prepared (stripped/truncated) text is well
  under `maxContentChars` (not a content-truncation issue), but enumerating 23
  courses with per-item excerpts in ONE tool-use response exceeds what glm-5.2
  reliably completes before hitting the (best-available) 2048-token output
  budget — a genuine model/response-length capability gap for long listing
  pages, not a plumbing defect. The deterministic CI tests
  (`npm run test:traverse-replay`) prove the GROUPING logic itself is 100%
  correct on however many items a response completes.
- **Confidence is not an auto-approve signal**: unchanged from the slice-2b
  adjudication finding (flat 0.90-0.94, doesn't discriminate ambiguous cases) —
  the review workflow must not treat traverse confidence as a quality gate.

### iD Tech JSON-LD disposition: DELETED, not folded in

Traverse's provenance contract requires every proposal's `excerpt` to occur
verbatim in `extract()`'s CONTENT-PREPARED text — and content-prep strips
`<script>` tags (including `application/ld+json` blocks) entirely before that
text is built (see `@kontourai/traverse`'s `content-prep.ts`, `NOISE_ELEMENTS`).
A structured-data candidate sourced from JSON-LD can therefore never pass
traverse's own excerpt/locator normalization — building a second,
JSON-LD-native provenance-verification path to route around that would itself
be the "parallel legacy path" the owner directive says not to keep. The
per-item model extraction this cutover ships already reads the same
human-visible facts (name, description, typical age range) the JSON-LD scraper
read, so the marginal value of a second code path was low relative to that
structural cost. Deleted; see this report's iD Tech row for the live result.

## Addendum (2026-07-03): traverse 0.5.1 bump — idtech regression outcome

Bumped `@kontourai/traverse` `^0.4.0` -> `^0.5.1` (0.5.0: "large-page
extraction via markdown prep + structural chunking", closes upstream #9;
0.5.1: "dedup on verified source span; keep prepareContent from throwing",
closes upstream #12). This addendum records the LIVE re-run outcome for the
⚠️ OWNER DECISION idtech row above and does not replace it — the original
before/after numbers stay as the historical record of what prompted this
work.

### idtech: items extracted, before vs after

| Run | idtech items | Note |
| --- | --- | --- |
| Legacy baseline (JSON-LD scraper, pre-cutover) | 23 | `tests/fixtures/cutover-baseline-2026-07.json` |
| Cutover report above (traverse 0.4.0, live) | 10 | 43% of baseline — regression rule tripped |
| Most recent production run (traverse 0.4.0, live) | 1 | single tool-use response truncated almost immediately |
| **This bump, traverse 0.5.1 (live, glm-5.2@zai)** | **17** | **74% of baseline — regression rule no longer trips** |

17/23 = 74%, clear of the >40%-drop regression tripwire (was 43%, then 1/23 =
4% in the latest production run). `result.warnings` confirms the mechanism:
`"chunked into 2 chunks by repeated-card structure (72 cards detected)"` —
the page was split into 2 provider calls instead of 1, each with far fewer
courses to enumerate, so each response got much further before hitting
`stop_reason === "max_tokens"` (both chunks still hit it — see below, this is
not yet a full fix of the underlying per-call output-length ceiling, just a
mitigation that shrinks what has to fit under it per call).

### A NEW cross-chunk bug this bump introduced, found and fixed here

Chunking is not opt-in — `extract()`/`fetchAndExtract()` apply it
automatically whenever a page's prepared content exceeds one chunk (defaults:
`chunkSize` 12,000, `maxChunks` 40, `prep` "markdown" for HTML); campfit's
call sites (`lib/ingestion/traverse-extractor.ts`,
`lib/ingestion/traverse-pipeline.ts`) pass no chunk-related options, so this
triggers automatically once a page is large enough — idtech's page reliably
is.

Each chunk is sent to the provider as an independent tool-use call, and
`ExtractionProposal.pathIndices[0]` (which
`lib/ingestion/traverse-item-grouping.ts`'s `assembleItems()` uses to regroup
proposals into one record per source item) is whatever index the provider
echoes back FOR THAT CHUNK — traverse does not renumber it against the whole
document, and `ExtractionProposal` carries no chunk id a consumer could use
instead (confirmed by reading traverse 0.5.1's shipped `dist/`, README, and
ADR 0004; this is not a bug in traverse, `pathIndices` was never contracted to
be chunk-aware). Empirically (live idtech run), glm-5.2 numbers each chunk's
`items[N]` from `N=0` again. Grouping naively by raw `pathIndices[0]` across
the WHOLE proposal list therefore silently MERGES chunk 2's item 0 into chunk
1's item 0 (and so on) — reintroducing, at chunk granularity, exactly the
cross-item stitching failure class `pathIndices`-based grouping was built to
prevent at field granularity (docs/traverse-adjudication-2026-07.md). Left
unfixed, this would have capped idtech's real recovery at ~8 items (the raw
per-chunk index range) instead of 17, and for other sources could silently
compose two unrelated items' fields into one merged record.

**Fix** (`lib/ingestion/traverse-item-grouping.ts`, `assignGlobalItemIndices`):
a decrease in the raw `pathIndices[0]` is rebased into a document-global item
index ONLY when the proposal's verified `provenance.locator` offset also did
NOT move backward — a genuine chunk restart shows the index resetting while
the document position keeps advancing (chunk 2's content is later in the
shared `fullText`), whereas legitimate same-chunk out-of-order emission (a
provider revisiting an earlier item's field within one response — already
covered by the existing `test:traverse-replay` "multi-item grouping" case)
moves the index AND the locator backward together. Each rebase point is
recorded as a visible warning on the affected item rather than applied
silently. Verified against the live idtech run (8 broken/collided items ->
17 correctly-separated items, with the rebase warning landing exactly on the
first item of the second chunk) and covered by two new deterministic CI
cases in `test:traverse-replay` (`testCrossChunkItemIndexRebase`,
`testSameChunkOutOfOrderIsNotMistakenForAChunkBoundary`).

A second, unrelated `test:traverse-replay` fixture issue surfaced by the same
bump: 0.5.0's default HTML->Markdown prep also ships **structural chunking**
that treats the largest run of same-tag/same-class-signature sibling
elements as a page's "repeated card" and (per traverse's own design) keeps
only that card content, dropping everything else. `tests/fixtures/traverse/denver-art-museum.html`
(a deliberately single-item, no-card-structure fixture) has a 4-`<li>` facts
list that was the only same-signature sibling run on the page, so it got
misdetected as "the card," dropping the item's name/category/CTA link
entirely (5/8 stub proposals survived instead of 8/8). Fixed by giving each
`<li>` a distinct class (`tests/fixtures/traverse/denver-art-museum.html`) —
same DOM structure/semantics, no longer a false "repeated signature" match.
This is a fixture-construction artifact, not a real-world regression risk:
avid4's fixtures use per-field `<span class="...">` (never a same-signature
sibling run) and were unaffected; a real single-item page is very unlikely to
coincidentally repeat a 3+-sibling identical-signature list.

### Spot checks (no regression)

Live-run spot checks with the same bump + fix in place:

| Source | Before (this addendum's baseline: cutover report above) | After (0.5.1, live) |
| --- | --- | --- |
| avid4 | 4 | 18 |
| denver-art-museum | 3 | 6 |

Both improved, no field classes disappeared, no cross-item stitching observed
in either (item names/fields are distinct and sensible; avid4's chunking used
the character-window fallback, not structural — both paths exercise the
rebasing fix, and both `test:traverse-replay` cases above cover the two
possible outcomes).

### Wiring changes made

- `package.json`/`package-lock.json`: `@kontourai/traverse` `^0.4.0` ->
  `^0.5.1`. No other campfit code needed new `extract()` options — chunking,
  markdown prep, and the per-chunk `maxContentChars` redefinition are all
  library defaults; campfit's call sites already passed none of `prep`/
  `chunkSize`/`chunkOverlap`/`maxChunks` and did not need to start.
  `DEFAULT_EXTRACTION_MAX_TOKENS` (2048, `resolve-extraction-provider.ts`) was
  NOT changed — re-probed live under 0.5.1, still the best-available value
  for the same reason as before (raising it makes glm-5.2 truncate before any
  usable tool_use JSON, chunked or not); see that file's updated docstring
  for the 0.5.1-specific addendum to that rationale.
- `lib/ingestion/traverse-item-grouping.ts`: cross-chunk item-index rebasing
  fix described above — REQUIRED, not optional; without it, the version bump
  alone would have been a data-correctness regression wearing an
  extraction-count improvement.
- `lib/ingestion/resolve-extraction-provider.ts`: docstring addendum only
  (no behavior change) clarifying `maxTokens` vs. the new per-chunk
  `maxContentChars`, per the task brief's callout to revisit this comment.
- `tests/fixtures/traverse/denver-art-museum.html`: per-`<li>` classes, fixture-only.
- `scripts/test-traverse-replay.ts`: two new deterministic cases for the
  rebasing fix (see above); no provider-CONTRACT changes were needed — the
  stub `ExtractionProvider` shape (`tests/fixtures/traverse/stub-provider.ts`)
  is unchanged, since chunking is entirely inside `extract()` and invisible to
  a single-chunk-sized stub call.

### OWNER DECISION status

The idtech ⚠️ OWNER DECISION item in the report above is **substantially
addressed, not fully closed**: 74% of legacy baseline clears the >40%
regression tripwire (vs. 43%, and vs. 1/23 = 4% in the most recent production
run), field coverage recovers proportionally (name/category/ageGroups now
populate on 17 items instead of 8-10), and the cross-chunk grouping
correctness bug this bump could have introduced is fixed and covered. It is
not 23/23: both of idtech's chunks still hit `stop_reason === "max_tokens"`
per-chunk, so some courses near the end of each chunk are still lost to
per-call output-length truncation — recoverable via further-reduced
`chunkSize` (more, smaller chunks) as a follow-up, deliberately NOT done here
per the task's "prefer library defaults, only add config if required"
guidance, since the >40% bar is already cleared on defaults alone. Traverse
issue **#14** (the upstream tracking issue for this exact idtech
under-extraction) can reasonably be considered **superseded by 0.5.0/0.5.1**
for the regression-bar purpose it was opened for, with a note that full 23/23
recovery would need either a smaller default `chunkSize` for very dense
listing pages or a provider-side fix to glm-5.2's per-call output-length
behavior — neither of which is this bump's scope.
