# @kontourai/survey 1.x Migration (campfit)

This is campfit's record of upgrading from `@kontourai/survey ^0.5.2` /
`@kontourai/surface ^0.9.0` to `@kontourai/survey ^1.3.0` / `@kontourai/surface ^1.3.1`
and adopting the 1.x producer-kit helpers. It mirrors `taxes/docs/survey-1.x-migration.md`:
what was adopted, what was intentionally kept, plan gaps found during execution, and
upgrade-guide fidelity findings. This upgrade was executed guide-first against
`@kontourai/survey`'s `docs/upgrade-guide.md`; every deviation is logged in the companion
`friction-journal.md`.

## Version bump

- `@kontourai/survey`: `^0.5.2` -> `^1.3.0`
- `@kontourai/surface`: `^0.9.0` -> `^1.3.1`
- Re-verified at execution time (per the guide's freshness warning):
  - `npm view @kontourai/survey@1.3.0 dependencies` -> `{ '@kontourai/surface': '^1.3.0' }`
  - `npm view @kontourai/surface@1.3.1 dependencies` -> (none)
  - `npm view @kontourai/survey@1.3.0 engines` -> `{ node: '>=22' }`
- `npm ls @kontourai/surface` dedupes to a single `@kontourai/surface@1.3.1` (survey's
  transitive dep deduped to the same copy). No two-major side-by-side.
- No `overrides["@kontourai/survey"]` entry existed on `origin/main` to remove (see plan gaps).

## Node engines floor (the headline finding)

`@kontourai/survey` declares `engines.node >= 22` (introduced at survey@1.0.0). campfit had
no `engines` field and all 7 `actions/setup-node` pins across 4 workflow files were on Node 20.
Fixed:
- Added `"engines": { "node": ">=22" }` to `package.json`.
- Bumped all 7 workflow pins to `"22"`: `ci.yml` (validate, build, survey_review_proof,
  verify_admin), `deploy.yml`, `production-smoke.yml`, `scrape.yml`.
- `grep -rn 'node-version: "20"' .github/workflows` now returns zero matches.

`npm` only warns (does not fail) on the engines mismatch without `engine-strict`, so this was a
latent runtime risk, not an install-time failure — which is exactly why it went unnoticed until
this upgrade.

## Adoption scorecard

| Helper | Adopted? | Why / why not |
| --- | --- | --- |
| `defineProductVocabulary` | Yes | `lib/trust-vocabulary.ts` now exports a single deep-frozen `campfitVocabulary` instead of four loose top-level constants. No `as const` needed (TS 6.0.3 clears the >=5.0 floor). All 6 downstream call sites updated. |
| `stableId` | Yes | The local reimplementation in `lib/surface-trust-export.ts` was byte-identical to Survey's exported `stableId` (same regex, same order); deleted and imported instead. |
| `confidenceBasisForReview` | Yes (delegated, campfit heuristic kept as explicit input) | `confidenceBasisFor` keeps campfit's `hasSupport`-driven `sourceQuality`/`evidenceStrength` mapping (fed in as explicit inputs, NOT relying on the helper's bare `"unknown"`/`"none"` defaults) and delegates assembly to the helper. campfit's algorithm is verifiably the "conservative" reference consumer the helper's own docstring is modeled on. Verified field-by-field zero output change across the full 12-combination status x review x confidence matrix. |
| `buildAuthorizedActionAuthorizing` / `buildPromptRef` | Yes | Replaced the hand-built `authorizing` object literal (hard-coded `promptRef: 'survey://campfit/approve-field@v1'`) in `lib/admin/trust-projection.ts`. `buildPromptRef({ scheme: 'survey', module: 'campfit', component: 'approve-field' })` reproduces the exact string; builder output is field-identical to the literal. |
| `applyReviewSession` | Yes | `deriveCampApplyFromSurveySession` (`lib/admin/survey-review-apply.ts`) now collapses the manual resolve-record -> derive-apply-result -> normalize-errors -> map-actions choreography into one call. The `{ ok }` discriminated result is converted to the existing `SurveyReviewApplyError` throw to preserve the throw-on-failure contract for both callers (neither wraps in try/catch). Verified via `verify:survey-apply` + `verify:survey-session`. |
| `currentProposedReviewItem` | **No — kept our hand-built builder** | See plan gap below. The shipped builder derives each candidate's top-level `id` as `${metadata.name}.${suffix}`, coupling the candidate-id prefix to the item name. campfit uses two distinct namespaces and cannot reproduce its exact candidate ids without breaking either `metadata.name` or persisted candidate ids. Empirically proven byte-for-byte. |
| `buildSurveyLearningProjections` | **No — kept our SQL metric** | `field_rejection_learning_signal` (`lib/admin/metrics-repository.ts`) is a persisted SQL row in the shared `CrawlMetric` table, aggregated by `getDashboardMetrics()`'s GROUP BY/time-window queries for the admin ops dashboard. `buildSurveyLearningProjections` produces an in-memory `LearningProjection[]` audit trail — a different consumption shape with no shipped BI/dashboard equivalent. Forcing adoption would mean a dual write with no consumer or rewriting the SQL aggregation layer (out of scope for a dependency bump). taxes adopted it because it had no pre-existing SQL/dashboard consumer competing for the concept. Backlog note: if campfit later builds a review-console consumer wanting `LearningProjection[]`, revisit. |

## Barrel deletion

`lib/kontourai/survey-review-workbench.ts` and `lib/kontourai/survey-review-server-session.ts`
were pure pass-through re-exports with zero added behavior. Deleted; all 8 former call sites now
import directly from `@kontourai/survey/review-workbench` and
`@kontourai/survey/review-workbench/server-review-session`. `grep -rn "lib/kontourai"` returns zero.

## Plan gaps found during execution

1. **Plan baseline assumed survey `^1.1.1`; the real base (`origin/main`) is `^0.5.2` / surface
   `^0.9.0`.** The plan was written against the `driving-session-1` dirty tree's stale, uncommitted
   `^1.1.1` mid-upgrade artifact. That bump was package.json-only ("never actually building against
   1.1.1's newer APIs"), so the code blast radius was identical from either base — but the version
   strings and the (absent) `overrides["@kontourai/survey"]` entry differed. AC1's "remove the
   now-unneeded survey override" sub-goal is N/A on this base: no such override exists.
2. **`currentProposedReviewItem` cannot be adopted byte-identically (AC4).** The plan asserted the
   builder derives candidate ids as `${candidateSetId}.suffix` and could be made byte-identical via
   `candidateIdSuffix` + `projection.candidateSetId`. The shipped 1.3.0 builder actually derives them
   as `${input.name}.${suffix}` — the candidate-id prefix is `metadata.name`, not `candidateSetId`.
   campfit's `metadata.name` (`camp-proposal-<id>-<field>`) and its `candidateSetId`
   (`camp.<campId>.field.<field>.proposal.<proposalId>.candidates`) are intentionally different
   namespaces. Empirically diffed: the only divergence between hand-built and builder output is the
   top-level candidate `id`, which would change from the `candidateSetId`-based value to the
   `metadata.name`-based value. That is exactly the persisted-id break AC4's stop-short risk warns
   about, so `currentProposedReviewItem` was NOT adopted for this builder. The hand-built builder is
   kept (byte-identical, zero risk) and a one-line "why" comment marks the call site.

## Upgrade-guide fidelity report

What `docs/upgrade-guide.md` got right:
- **Re-check `npm view` at execution time.** Followed; no stale finding (no newer patch published
  since planning). Good, high-value advice.
- **`npm ls @kontourai/surface` single-dedupe check.** Followed; confirmed single copy.
- **The `confidenceBasisForReview` worked example / "keep your own mapping" pattern.** Accurate —
  campfit is exactly the "conservative reference consumer" the helper's docstring describes, and the
  guide's advice to leave a one-line "why" comment at the call site was followed.
- **The const-type-param / TS >= 5.0 note.** Accurate: `defineProductVocabulary` needed no `as const`
  under TS 6.0.3.
- **The adoption-scorecard pattern.** Reused here.

What the guide missed (findings this delivery contributes back):
1. **The `engines.node >= 22` floor is never mentioned anywhere in the guide** — despite being a hard
   CI blocker for a pre-1.0 consumer whose CI is pinned below Node 22. This is the single
   highest-value gap. It is exactly the "discovered by direct experience" class of finding the
   guide's opening paragraph says it exists to capture. Recommended: add an "engines / runtime floor"
   section to the guide alongside the TS >= 5.0 note.
2. **`currentProposedReviewItem`'s coupling of the candidate-id prefix to `metadata.name` is not
   called out as an adoption constraint.** The doc comment states candidate ids default to
   `<name>.current` / `<name>.proposed`, but neither the guide nor the doc comment flags that a
   consumer whose candidate-id namespace differs from its item name cannot adopt the builder without
   changing persisted ids. Recommended: add a "when the builder does not fit" note to the scorecard,
   parallel to the `confidenceBasisForReview` worked example.

## Verification

Local (all green): `tsc --noEmit`, `lint`, `build`, `verify:survey-review-items`,
`verify:survey-apply`, `verify:survey-session`, `verify:survey`, `test:surface`, `test:learning`.
`verify:admin`'s access-control tests pass locally; its database portion and `verify:survey-browser`
(Playwright) require the Postgres service + admin auth that only the CI `survey_review_proof` /
`verify_admin` jobs provision, and are deferred to CI (this branch was not pushed; publish follows
gate approval).

## 1.3.0 -> 1.5.0 (surface 2.x)

A follow-on bump from `@kontourai/survey ^1.3.0` / `@kontourai/surface ^1.3.1` (the
adoption documented above) to `@kontourai/survey ^1.5.0` / `@kontourai/surface ^2.0.0`.
Executed guide-first against `docs/upgrade-guide.md`'s "Facet rename (Hachure schema 5)"
section on branch `chore/survey-1.5.0-surface-2`.

### Version bump

- `@kontourai/survey`: `^1.3.0` -> `^1.5.0`
- `@kontourai/surface`: `^1.3.1` -> `^2.0.0`
- Re-checked `npm view` at execution time per the guide's freshness warning (a same-day
  `1.5.0` had just published, superseding the plan's `1.4.0` target — the guide's own
  "a plan-time finding can go stale within hours" caution held true here):
  - `npm view @kontourai/survey@1.5.0 dependencies` -> `{ '@kontourai/surface': '^2.0.0' }`
  - `npm view @kontourai/surface@2.0.0 dependencies` -> `{ '@kontourai/surface': '^2.0.0' }` (i.e. no further transitive deps)
  - `npm view @kontourai/survey@1.5.0 engines` -> `{ node: '>=22' }` (already satisfied; no change)
- `npm ls @kontourai/surface` dedupes to a single `@kontourai/surface@2.1.1` (survey's
  own `^2.0.0` dependency deduped to the same copy `npm install` resolved for campfit's
  direct `^2.0.0` range). No two-major side-by-side.
- `npm ls @kontourai/survey` -> single `@kontourai/survey@1.5.0`.
- No other declared dependency ranges were touched. `@kontourai/datum` stayed
  `^0.3.0` and `@kontourai/traverse` stayed `^0.6.0` (their installed versions already
  matched their declared ranges after `npm install`; a stale pre-bump scan had flagged
  them, but that was a plan-time finding, not something this bump needed to touch).

### What renamed (per `docs/upgrade-guide.md`'s "Facet rename" section)

`@kontourai/surface@2.0.0` renames `Claim.surface` to `Claim.facet` (schema version
bumps to `5`); `@kontourai/survey@1.4.0` followed that rename across every claim-target
shape it emits or declares:

- `ClaimTarget.facet` / `ClaimTargetHint.facet` / `OversightMetricsClaimsSubject.facet`
  (previously `.surface`) — renamed, **no compatibility alias**.
- `buildSurveyTrustBundle` now writes `Claim.facet` and stamps `schemaVersion: 5` on
  every bundle (was `3`).
- `defineProductVocabulary`'s `surface` option is renamed to `facet`, with a
  **deprecated `surface` alias kept for one release** (accepts either, `facet` wins,
  warns once per process if only `surface` is given; the returned vocabulary carries
  both `.facet` and a deprecated `.surface` mirror).
- `SurfaceTrustCoverage` renamed to `FacetTrustCoverage` (deprecated alias kept) — not
  used anywhere in campfit (`grep` confirmed zero hits), no change needed.

### What campfit changed

Only the fields that are hard-renamed with no compatibility alias needed edits (6
call sites across 4 files, all `ClaimTarget`/claim-literal `.surface` -> `.facet`):

- `lib/trust-vocabulary.ts` — `defineProductVocabulary({ surface: ... })` ->
  `defineProductVocabulary({ facet: ... })`. Migrated straight to the canonical
  option rather than leaning on the deprecated `surface` alias, since the guide
  flags the alias as "not guaranteed to survive the next release."
- `lib/surface-trust-export.ts` — two claim literals (`forClaim({ surface: ... })`
  in `toRegistrationStatusObservation`, and the `claim: { surface: ... }` object in
  `toScheduleObservation`) -> `facet: campfitVocabulary.facet`.
- `lib/admin/trust-projection.ts` — `campClaim()`'s shared claim-builder helper
  (used by both the current-value and proposed-value observation builders) ->
  `facet: campfitVocabulary.facet`.
- `lib/admin/survey-review-items.ts` — `currentCandidate()` and `proposedCandidate()`'s
  `claimTarget: { surface: ... }` object literals -> `facet: campfitVocabulary.facet`.
- `scripts/test-surface-trust-export.ts` — updated the hard-coded
  `assert.equal(proof.schemaVersion, 3)` to `5` to match `buildSurveyTrustBundle`'s new
  stamped schema version; this was the only test asserting on `schemaVersion` anywhere
  in the repo (`grep -rn schemaVersion` confirmed).

`npx tsc --noEmit` surfaced every one of the 6 call-site edits directly (5 distinct
`TS2353`/`TS2322` "surface does not exist" / "facet is missing" errors across 4 files);
no fallout was found by inspection alone that `tsc` missed, and no fallout `tsc`
flagged was left unfixed.

### What was declined / unchanged (honoring the prior scorecard)

- **`currentProposedReviewItem`** — still not adopted. The candidate-id-prefix /
  `metadata.name` coupling documented above under "Plan gaps found during execution"
  is unrelated to and unaffected by the facet rename; the hand-built builder in
  `lib/admin/survey-review-items.ts` is untouched apart from the `surface` ->
  `facet` field rename inside its `claimTarget` object literals.
- **`buildSurveyLearningProjections`** — still not adopted into
  `lib/admin/metrics-repository.ts`'s SQL-backed `field_rejection_learning_signal`
  metric, for the same reason recorded above (different consumption shape, no
  dashboard consumer). `scripts/test-review-learning-signals.ts` still imports
  `buildSurveyLearningProjections` directly, but only to verify campfit's own SQL
  dimensions do **not** silently pick up survey's `LearningProjection` shape
  (`surveyLearningProjectionKind`/`Signal`/`Source` all asserted `undefined`) —
  this is parity-testing an intentional non-adoption, not adoption; no change
  needed for the rename since that script never touches a `ClaimTarget` or claim
  literal directly (it calls into `buildCampReviewSurveyInput`, which was already
  fixed above).
- **`applyReviewSession`'s throw-on-`{ ok: false }` semantics** — `lib/admin/survey-review-apply.ts`
  is untouched by this delivery (confirmed via `git diff --stat`); the facet rename
  does not touch the apply-session envelope shape at all.
- **`confidenceBasisForReview`, `buildAuthorizedActionAuthorizing`/`buildPromptRef`,
  `stableId`** — unaffected by the facet rename (none of these touch `Claim.facet`
  or `ClaimTarget.facet`); left exactly as adopted in the 1.3.0 delivery.

### Verification

Local (all green, exit 0): `tsc --noEmit`, `lint` (includes `eslint .` plus the
content-boundary/decisions/ingestion/render/traverse test chain), `build`,
`verify:survey-review-items`, `verify:survey-apply`, `verify:survey-session`,
`verify:survey`, `test:surface`, `test:learning`, `verify:survey-browser`
(Playwright — 9 passed / 2 skipped, ran locally against a full Chromium install,
not deferred to CI this time).

`npm ls @kontourai/surface` / `npm ls @kontourai/survey` both dedupe to a single
copy (`2.1.1` / `1.5.0` respectively) — recorded verbatim in this delivery's
friction journal (`.kontourai/flow-agents/campfit-survey-15-upgrade/friction-journal.md`).
