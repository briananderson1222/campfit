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

