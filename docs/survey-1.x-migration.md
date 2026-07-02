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
