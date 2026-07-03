> **SUPERSEDED (2026-07 full cutover).** This document describes the
> Slice 1b/2b PILOT state (traverse behind a flag for 2 rotted sources,
> legacy CSS-selector scrapers primary elsewhere, single-entity schema).
> That state no longer exists: traverse is now THE ingestion pipeline for
> every source, the legacy scrapers/flag/shadow plumbing described below
> were deleted, and the schema is per-item, not single-entity. See
> **[`docs/traverse-ingestion.md`](./traverse-ingestion.md)** for the
> current architecture and **[`docs/cutover-report-2026-07.md`](./cutover-report-2026-07.md)**
> for the before/after cutover results. Kept as-is below for historical
> record of the pilot decision process.

---

# Traverse pilot (Slice 1b) — schema-directed extraction alongside the selector scrapers

Status: **PILOT** (runs beside the legacy scrapers behind a separate command;
nothing is removed or replaced).
Package: [`@kontourai/traverse@0.2.0`](https://www.npmjs.com/package/@kontourai/traverse)
(npm-live), Anthropic adapter via `@kontourai/traverse/anthropic`. `0.2.0` adds
`opts.baseUrl`, letting the pilot point at any Anthropic-compatible endpoint
(e.g. Z.AI). Provider/model/key resolution for the LIVE parity run goes through
[`@kontourai/datum@0.2.0`](https://www.npmjs.com/package/@kontourai/datum)
(npm-live) — see the datum recipe below.

## Why

The weekly selector scrapers (`lib/ingestion/scrapers/*.ts`) are brittle: when a
source moves or rebuilds its markup, the CSS selectors silently match zero
elements and the scraper returns 0 camps. The **Denver Art Museum** source is
the live example — its page relocated (2026-06-15+), the markup was rebuilt, and
`DenverArtMuseumScraper` now finds nothing (flagged NEEDS REVIEW in
`lib/ingestion/scrapers/denver-arts.ts`). Traverse points a *schema* (field
descriptions), not selectors, at the prepared page text, so a markup change
doesn't break extraction the same way.

Traverse is a **proposer only** — every output is a provenance-bearing
`ExtractionProposal` (verbatim `excerpt` + verified `chars:<start>-<end>`
`locator`), never a direct write. That matches CampFit's review discipline
(ADR 0003-style: human-reviewed proposals, never direct writes), so the pilot
wires traverse outputs into the **existing** review sink.

## What was built

| File | Role |
| --- | --- |
| `lib/ingestion/traverse-schema.ts` | `CAMP_TARGET_SCHEMA` — the camp/program listing shape (name, description, category, registration URL, location, session dates, ages, price) derived from the real `CampInput` scraper output type. Traverse defines no field names itself; every path/enum/description here is caller-owned. |
| `lib/ingestion/traverse-extractor.ts` | Pilot wiring: `runTraverseExtraction()` runs `extract()` against the schema; `traverseProposalsToProposedChanges()` + `buildTraverseProposalRecord()` map proposals into CampFit's existing `ProposedChanges` / `createProposal` review contract — the same sink the crawl pipeline feeds the Survey review workflow (PR #31). It does **not** write to the DB; human-review policy owns the write. |
| `lib/ingestion/resolve-extraction-provider.ts` | `resolveExtractionProvider()` — resolves the LIVE traverse `ExtractionProvider` via `@kontourai/datum`'s `resolve(ref)` (default ref: `extraction-default`, or `TRAVERSE_ROLE`), reading `.datum/config.json`'s `zai` / `anthropic` providers. Only imported by `scripts/traverse-parity.ts` — never by the replay test, so CI needs no datum config or key. |
| `lib/ingestion/traverse-snapshot-store.ts` | Shared filesystem snapshot store (`@kontourai/traverse/fetch`) + honest fetch UA. Every LIVE traverse fetch captures byte-identical bytes under `.kontourai/campfit/snapshots/` (gitignored) so proposals are replay-traceable. |
| `lib/ingestion/traverse-ingestion.ts` | The **flagged** ingestion path (`TRAVERSE_INGESTION`): `runTraverseIngestion()` routes the rotted sources through `fetchAndExtract` (`live-with-capture`) → `buildTraverseProposalRecord` → an injected review **sink**, running the legacy scraper in shadow for count telemetry. DB-free + testable (injected sink/store/fetch). |
| `lib/ingestion/scrapers/idtech.ts` | `IdTechScraper` — the first **healthy** live source, parsing idtech.com/courses schema.org JSON-LD (robust, not CSS-selector-fragile). Makes field agreement (criterion 4) measurable. |
| `scripts/test-traverse-replay.ts` (`npm run test:traverse-replay`) | CI-safe REPLAY proof over stored HTML snapshots with a deterministic STUB provider (no API key). |
| `scripts/traverse-parity.ts` (`npm run traverse:parity`) | LIVE parity harness (NOT in CI) — real Anthropic-compatible provider (resolved via datum) vs the legacy scraper over the same fetched pages. |
| `tests/fixtures/traverse/*.html` | Stored snapshots: one healthy source, plus the rebuilt Denver Art Museum page. |
| `tests/fixtures/traverse/stub-provider.ts` | Deterministic `ExtractionProvider` for the replay test. |

### How outputs route to review

A traverse proposal becomes a `FieldDiff` in a `ProposedChanges` map, keyed by
its `fieldPath`:

- **Scalar paths** (`name`, `description`, `category`, `applicationUrl`, `city`,
  …) are diffed against the current camp value — emitted only when they differ,
  with `mode: 'populate'` when the current value is empty else `'update'`.
- **Nested/array paths** (`schedules[].startDate`, `ageGroups[].minAge`,
  `pricing[].amount`, …) are additive proposals (`mode: 'add_items'`, `old: null`).

Every `FieldDiff` carries the traverse `excerpt` and `sourceUrl` (what the
Survey review UI already renders). The full traverse payload — proposals with
their **verified** locators, raw response, and warnings — is preserved in
`rawExtraction` for audit. `buildTraverseProposalRecord()` returns an object
whose fields line up 1:1 with `createProposal(...)` in
`lib/admin/review-repository.ts`, proving the routing without performing the
write.

## What the pilot proved (REPLAY, CI-gated)

`npm run test:traverse-replay` (wired into `npm run lint`, and its own CI step)
asserts, over the two stored snapshots:

1. **Provenance is real, not prompted.** Each surviving proposal's `excerpt`
   occurs verbatim in the prepared text and its `chars:<start>-<end>` locator
   slices out exactly that excerpt. A stub proposal whose excerpt is *not* on
   the page is **dropped** with `"excerpt not found in prepared content"`.
2. **Nothing is silent.** Warnings surface for the dropped excerpt, a clamped
   out-of-range confidence (1.4 → 1.0), and provider-side notes passed through.
3. **Outputs route to the review path.** Proposals become a `ProposedChanges`
   map with excerpt + sourceUrl provenance and a `createProposal`-shaped record.
4. **Denver rescue.** Over the SAME snapshot, `DenverArtMuseumScraper` returns
   **0 camps** (stale selectors) while traverse produces **8 verified
   proposals** (name, category, ages, dates, price, city, registration URL) —
   exactly the case schema-directed extraction is meant to rescue.
5. **Per-source isolation preserved.** A provider that throws surfaces as
   `result.error` (traverse `extract()` never throws) with no proposals, and the
   next source in a sweep still runs — matching `scrape-runner.ts`'s contract
   from PR #32.

## Parity harness (LIVE) — status: VERIFIED (Slice 2b, glm-5.2@zai)

`npm run traverse:parity` runs the legacy scraper and the real traverse
provider over the same freshly-fetched pages and writes a per-field
agreement / traverse-only / selector-only / confidence-distribution report to
`artifacts/traverse-parity/<timestamp>/` (gitignored). As of Slice 2b it also
fetches the traverse side via `@kontourai/traverse/fetch` `fetchAndExtract`
(`live-with-capture`), so each run captures a byte-identical **snapshot** per
source (under `.kontourai/campfit/snapshots/`) and persists **full per-proposal
detail** (value + verified excerpt + locator) for adjudication.

It was run live on **3 sources** (`avid4`, `denver-art-museum`, `idtech`) via
the datum `extraction-default` role (`glm-5.2@zai`). The adjudication of that
run — every proposal judged for factual correctness, the Denver disagreements
ruled, and the observed glm-5.2 quality characteristics — is in
[`docs/traverse-adjudication-2026-07.md`](./traverse-adjudication-2026-07.md).
Headline: 14/18 surviving values correct, 4 ambiguous (plausible-but-mis-composed
ranges/names), **0 fabricated** (the verbatim-excerpt gate dropped everything
unanchored).

### Provider resolution via datum

The provider, model, base URL, and API key are resolved by
[`@kontourai/datum@0.2.0`](https://www.npmjs.com/package/@kontourai/datum)
(`lib/ingestion/resolve-extraction-provider.ts`), not hand-plumbed env vars.
This repo commits `.datum/config.json` with two providers — `zai`
(Anthropic-compatible, `https://api.z.ai/api/anthropic`, key from
`ZAI_API_KEY`) and `anthropic` (key from `ANTHROPIC_API_KEY`) — and one role,
`extraction-default: "glm-5.2@zai"`. The file holds **references only**
(env var names), never a secret, and is safe to commit — datum's validator
rejects a key-looking literal in any auth field.

To run the parity harness:

```sh
export ZAI_API_KEY=...          # the key the extraction-default role's
                                 # zai provider references (or add it to
                                 # .env.local)
npm run traverse:parity
# → artifacts/traverse-parity/<timestamp>/report.md
```

Preflight check (confirms the config parses, the role resolves, and the key
actually works against the live endpoint with a single `max_tokens: 1` call —
the only place datum touches the network):

```sh
npx datum doctor --probe
```

### Switching models / providers

- `TRAVERSE_ROLE=<role>` — resolve a different datum role entirely (e.g. a
  `worker` or `anthropic-default` role added to `.datum/config.json`).
- `DATUM_ROLE_EXTRACTION_DEFAULT=<model@provider>` — datum-native escape
  hatch: override what the `extraction-default` role points at for one run,
  without touching the config file, e.g.:

  ```sh
  export ANTHROPIC_API_KEY=sk-ant-...
  export DATUM_ROLE_EXTRACTION_DEFAULT="claude-sonnet-5@anthropic"
  npm run traverse:parity
  ```

- `TRAVERSE_MODEL` / `ANTHROPIC_BASE_URL` — explicit, final overrides applied
  on top of whatever datum resolves (kept for one-off pins). Prefer the
  datum-native mechanisms above for anything more than a one-off.

Both the console output and `report.md`/`report.json` record which backend
produced the run: `provider.name` gets an `@<host>` suffix from `baseUrl`
(e.g. `anthropic-extraction-provider:glm-5.2@api.z.ai`); each source entry
also carries `datumRef`/`datumProvider` (which role/provider resolved) and
`traverseModel` — the model the provider's raw response actually reports,
which may differ from the resolved model id if the backend remaps model
names (e.g. Z.AI remaps Claude-style names to GLM equivalents).

(There is no sidecar tooling in this repo, so the original NOT_VERIFIED gap is
recorded here and in the PR body rather than in a tracker.)

## Promotion criteria — making traverse the primary extractor

Status legend: ✅ met · 🟡 partial/scoped · ⬜ open.

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| 1 | **Live parity on ≥3 sources** (incl. Denver Art Museum), human-reviewed | ✅ | avid4 + denver-art-museum + idtech run live (glm-5.2@zai); adjudicated in `traverse-adjudication-2026-07.md`. NOT_VERIFIED gap closed. |
| 2 | **Denver rescue confirmed live** — correct proposals where selectors read nothing | ✅ | Legacy 1 weak camp; traverse recovered price ($400/$450), ages, session window, OPEN status, all excerpt-verified. |
| 3 | **No provenance regressions** — every proposal carries a verified excerpt + locator | ✅ | Live output holds the replay invariant; glm-5.2 paraphrases were dropped, not accepted (Denver ×2). |
| 4 | **Field agreement bar on a healthy source** | 🟡 | First measurable via idtech (working JSON-LD scraper). Agree on page-level fields (category, min age); all disagreements are per-course-vs-page **granularity** artifacts of the single-entity schema, not accuracy failures. A per-item schema is the follow-up to fully clear this bar. |
| 5 | **Cost/latency acceptable** at the weekly cadence | ⬜ | Not yet measured for a full sweep. |
| 6 | **Reviewer sink wired for real** behind a flag | ✅ | `TRAVERSE_INGESTION` routes rotted sources through `buildTraverseProposalRecord → createProposal` (see below); routing proven network-free in `test:traverse-replay`. |

### Decision record (Slice 2b)

**Traverse is primary *behind a flag* for the selector-dead sources
(`avid4`, `denver-art-museum`), with the legacy scraper running in shadow;
healthy sources stay legacy-primary until the field-agreement bar (criterion 4)
is cleared with a per-item schema.**

Rationale: both live selector sources are dead or dying, so the legacy baseline
can no longer anchor a quality bar there — traverse is strictly better than 0
camps, and its worst surviving errors are reviewer-catchable structural ones
(never fabrications). On the one *healthy* source, traverse and the working
scraper agree on genuinely page-level fields; the remaining disagreements are
granularity (one page-level record vs. 23 per-course rows), not wrongness — not
yet enough to promote traverse ahead of a healthy per-item scraper. So: rotted
sources → traverse-primary-behind-flag + legacy shadow; healthy sources →
legacy-primary, traverse compared only.

### How the flag is scoped + how to flip it

`TRAVERSE_INGESTION` (env flag; truthy = `1`/`true`/`on`/`yes`) — off by
default, and with it off the scrape sweep is **byte-identical** to before.

When on, in `scripts/scrape.ts`:

- the **rotted** sources (`ROTTED_SOURCE_KEYS` = `avid4`, `denver-art-museum`)
  route through `runTraverseIngestion` — fetch `live-with-capture` → traverse
  extract → `buildTraverseProposalRecord` → `createProposal` (the Survey review
  sink), with the legacy scraper still run in **shadow** and its camp count
  logged next to the traverse proposal count;
- **healthy** sources (e.g. `idtech`) are **not** in the rotted set and run the
  normal legacy path unchanged — the flag does not touch them in this slice.

```sh
# Route the two selector-dead sources through traverse into the review queue:
export ZAI_API_KEY=...            # key for the extraction-default datum role
export TRAVERSE_INGESTION=1
npm run scrape                    # needs the DB; writes CampChangeProposals for review
```

The extraction provider is resolved via datum (`extraction-default` role); if it
cannot resolve, the rotted sources **fall through to legacy** rather than fail
the sweep. Snapshots land under `.kontourai/campfit/snapshots/` (gitignored);
CI never runs this path (it uses the replay/stub provider and never fetches).

## Notes / deviations

- Traverse's `extract()` signature is
  `extract({ content, contentType, sourceRef, targetSchema, fieldHints?, provider, maxContentChars? })`
  (per its shipped types) — the pilot wraps it in `runTraverseExtraction()`.
- Traverse's content-prep is a dependency-free HTML→text stripper (not cheerio);
  provenance offsets are anchored to that **prepared** text, so any raw-source
  highlighting must re-run the same prep. Documented in traverse's README.
- PDF content-prep is deferred in 0.1.0 (returns a typed error) — not exercised
  here; all snapshots are HTML.
- `resolveExtractionProvider()` (`lib/ingestion/resolve-extraction-provider.ts`)
  is the ONLY place datum's `resolve()` is called; it is only imported from
  `scripts/traverse-parity.ts`. `test:traverse-replay` and its stub provider
  (`tests/fixtures/traverse/stub-provider.ts`) never import it — CI needs no
  `.datum/config.json` and no key present to stay green.
