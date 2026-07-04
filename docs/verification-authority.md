# Verification Authority

This is CampFit's durable architecture note for delegating Camp/Session
verification-status computation to `@kontourai/surface`'s evaluator and
persisting the Claims/Evidence/Events that back it. It uses the domain
vocabulary defined in
[`docs/contexts/trust-review-provenance/CONTEXT.md`](./contexts/trust-review-provenance/CONTEXT.md)
(**Claim**, **Verification Policy**, **Verification Gap**, **Verified Camp
Claim Set**, **Verified Session Claim Set**, **Verification Status**) and
[`docs/contexts/data-stewardship/CONTEXT.md`](./contexts/data-stewardship/CONTEXT.md)
(**Attestation**, **Reviewed**, **Stale**) throughout. Full delivery
history — the 8 crystallized decisions, wave-by-wave execution notes, and
every flagged deviation/accepted gap — lives in
[`.kontourai/flow-agents/verification-authority/`](../.kontourai/flow-agents/verification-authority/)
(`verification-authority--deliver.md` is the session record;
`verification-authority--deliver-plan.md` is the plan). This slice also
ratifies [`docs/decisions/verified-camp-claim-set.md`](./decisions/verified-camp-claim-set.md)
and [`docs/decisions/verified-session-claim-set.md`](./decisions/verified-session-claim-set.md),
which express ADR-0002 (`docs/adr/0002-verified-camp-session-claim-sets.md`)
as this module's concrete claim sets.

## Why

Before this slice, `Camp.dataConfidence`/`lastVerifiedAt` were hand-maintained
booleans written from 3 different places with no shared evaluation logic:
`lib/admin/review-apply.ts`'s `recomputeVerification` (coverage-gated on
`lib/admin/verification.ts`'s `isFullyVerified`/`REQUIRED_FOR_VERIFIED`), and
two unconditional `UPDATE ... dataConfidence = 'VERIFIED'` writers
(`mark_verified` and the assistant's `mark_camp_verified`). None of these
consulted an auditable evidence trail, and two attestation stores
(`Camp.fieldSources` JSON and the `FieldAttestation` table) had accumulated
independently, never reconciled. Sessions (`CampSchedule` rows) had no
identity of their own — every Review Apply deleted and recreated them with
fresh UUIDs — so nothing durable could ever be a claim subject for them, and
the coverage meter's "9th requirement" (`schedules`) was just "does at least
one row exist," not a real verification.

## Delegation architecture

**`@kontourai/surface` 2.3.0's evaluator is the authority; CampFit owns claim
sets, policies, evidence, and persistence.** CampFit never reimplements
`foldClaim`/`deriveClaimStatus`/`deriveTrustSnapshot`/`deriveClaimGroupRollups`/
`applyDerivation` — those are Surface's, consumed unmodified. CampFit's job is
everything Surface does not and should not know about:

- **Expressing** the Verified Camp Claim Set and Verified Session Claim Set
  (ADR-0002) as concrete Surface `ClaimGroup`/`VerificationPolicy` values
  (`lib/admin/verification-policy.ts`, pure data/functions, no I/O).
- **Persisting** Claims/Evidence/Events in Postgres and reconstructing
  Surface-shaped objects at read time (`lib/admin/claim-store.ts`).
- **Feeding evidence** from every place CampFit's admin surface records a
  human or crawl-derived fact (`lib/admin/bulk-attestation.ts`,
  `lib/admin/entity-admin-repository.ts`'s `recordCampAttestationEvidence`,
  `lib/admin/review-apply.ts`'s `recordAppliedFieldEvidence`).
- **Composing and caching** the evaluation result
  (`lib/admin/verification-authority.ts`'s `deriveCampVerification`/
  `deriveSessionVerification`/`refreshCampVerificationCache`) and projecting
  Surface's 9-valued `TrustStatus` down to CampFit's existing 3-valued
  `DataConfidence` column.

`lib/admin/verification.ts` (`isFullyVerified`/`REQUIRED_FOR_VERIFIED`/
`computeCoverage`) is **deleted** — the required-field list is now policy
data, not a hand-maintained constant. A repo-wide grep for
`isFullyVerified`/`REQUIRED_FOR_VERIFIED`/`computeCoverage`/
`lib/admin/verification'` returns only historical comments.

## Module interface

`lib/admin/verification-authority.ts` is the sole computer of Camp/Session
verification status and exports:

```ts
deriveCampVerification(campId: string, options?: { now?: Date }): Promise<ClaimGroupRollup>
deriveSessionVerification(scheduleId: string, options?: { now?: Date }): Promise<ClaimGroupRollup>
refreshCampVerificationCache(campId: string, options?: { now?: Date }): Promise<{ dataConfidence: DataConfidence; lastVerifiedAt: Date }>
buildInheritedSessionClaims(params: { campId, scheduleId, existingClaimIds, now? }): InheritedSessionClaimsResult
revokeArchivedSessionClaims(params: { orphaned, actor, method, now? }): Promise<VerificationEvent[]>
coverageFromRollup(rollup: ClaimGroupRollup, campValues: Partial<Camp>): CoverageResult
recordEvidence   // re-exported from lib/admin/claim-store.ts
projectTrustStatusToDataConfidence   // re-exported from lib/admin/verification-policy.ts
```

`refreshCampVerificationCache` is the **only** writer of
`Camp.dataConfidence`/`lastVerifiedAt` in the codebase — a repo-wide grep for
`dataConfidence" =` outside this module returns no matches. `recordEvidence`
and `projectTrustStatusToDataConfidence` are re-exported (not reimplemented)
so every writer call site (below) has exactly one module to import from.

`deriveCampVerification`/`deriveSessionVerification` assemble one Surface
`TrustBundle` per evaluation (the Camp's own field Claims + every
non-archived Session's own Claims), hand it to `deriveTrustSnapshot`, and
return the resulting `ClaimGroupRollup` for the Verified Camp/Verified
Session `ClaimGroup`. Two kinds of Claim are synthesized fresh, in-memory, on
every evaluation rather than persisted (migration 012's `SurfaceClaimDefinition`
carries no `derivedFrom` column):

1. **Inherited Session Attribute Claims** — `eligibility`,
   `registration-status`, `price-options`, `registration-path` are
   `derivedFrom` the corresponding Camp-level Claim, `metadata.inherited:
   'camp-level'`, whenever no real per-Session Claim already exists.
2. **Rollup Claims** — `session.<id>.verified` and
   `camp.<id>.sessions-verified`, each given an own status of `verified` via
   a synthesized `calculation_trace` Evidence + `verification` Event (an
   unregistered, module-local claim type no policy resolves against), then
   bounded down by `applyDerivation`'s ceiling to the weakest of their
   `derivedFrom` inputs. Because the Camp's `sessions-verified` Claim's
   `derivedFrom` list is rebuilt from the *current* non-archived
   `CampSchedule` rows on every evaluation, an archived Session simply stops
   contributing on the next evaluation — no separate "recompute derivedFrom"
   step is needed.

Evaluation bundles are deliberately **not** run through `validateTrustBundle`:
that check enforces every `derivedFrom` reference resolves to a present
claim, which is exactly what a genuine Verification Gap violates.
`deriveTrustSnapshot`'s own `applyDerivation` already handles a missing
derivation input gracefully (a `transparencyGap` + a ceiling capped to
`unknown`, not a thrown error) — that graceful handling is what lets a
missing Claim surface as an explicit gap instead of a hard failure.

## ClaimStore Postgres materialization

Surface's own file-based `ClaimStore` API (`store.d.ts`'s
`loadClaimStore(path)`/`saveClaimStore`) is a single-project CLI catalog
shape — one JSONB-sized blob per store — not multi-tenant-DB shaped. A Camp's
Claim/Evidence/Event history needs per-subject query and independent-writer
concurrency, so migration 012
(`prisma/migrations/012_claim_store_and_session_identity.sql`) normalizes
Surface's typed shapes 1:1 into Postgres instead of mirroring the file:

| Table | Mirrors | Notes |
| --- | --- | --- |
| `SurfaceVerificationPolicy` | `VerificationPolicy` | One row per claim type's policy. |
| `SurfaceClaimDefinition` | `ClaimDefinition` (identity only — no `value`/`status`) | FK to policy; indexed on `(subjectType, subjectId)` and `claimType`. |
| `SurfaceEvidence` | `Evidence` | Append-only; FK-cascades from its claim. |
| `SurfaceVerificationEvent` | `VerificationEvent` | Append-only (the status-bearing ledger `foldClaim` evaluates); `method` is free-text, matching Surface's own `string` type, unlike `SurfaceEvidence.method`'s closed enum. |
| `SurfaceClaimGroup` | `ClaimGroup` | `requirements`/`rollupPolicy`/`metadata` as JSONB. |

Also additive/nullable: `CampSchedule.archivedAt` (soft-archive column for
stable Session identity, below) and `CampPricing.scheduleId` (nullable FK,
existing rows stay `NULL`/camp-wide — a future per-schedule-priced Proposal
can populate it as a real, non-inherited `price-options` evidence path).
Both are zero-data-loss, zero-behavior-change for existing rows. The
migration is idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF
NOT EXISTS`) and, in this delivery, applied only against the throwaway
`TEST_DATABASE_URL` Postgres via `scripts/test-db-reset.ts` (migration 012
appended last, after 011 — see this repo's Ops runbook section below for the
production step).

`lib/admin/claim-store.ts` implements `@kontourai/surface`'s
`ClaimStoreAdapter` interface (`createPostgresClaimStoreAdapter`) against
these tables, adapted from the package's own
`examples/postgres-claim-store/` reference implementation. Every mutation
still routes through Surface's own pure functions
(`buildClaimDefinition`/`addClaimToStore`/`updateClaimInStore`/
`addAuthoredClaim`/`updateAuthoredClaim`) on an in-memory `ClaimStore`
reconstructed by `.load()`, then persisted via `.save()` — never a
hand-rolled row-level diff of claim-catalog semantics.

**What has no columns, and fails loud.** Several optional fields on
Surface's own types have no backing column in migration 012 and no generic
catch-all to stash them in:

- `VerificationPolicy.requiredMethods` / `.requiresCorroboration` /
  `.collectWhen` / `.incompatibleValues` / `.incompatibleStatuses`
- `Evidence.supportStrength` / `.integrityAnchor` / `.passing` /
  `.blocking` / `.execution`

`upsertPolicy`/`appendEvidence` **fail loud** (throw) if a policy or evidence
record sets any of these, rather than silently dropping the data. None of
`VERIFIED_CAMP_SESSION_POLICIES` (`lib/admin/verification-policy.ts`) or the
Surface builders this repo calls (`buildHumanAttestationEvidence`) ever set
them, so this has not fired in practice — it is a guardrail against a future
policy/evidence author accidentally relying on a field this schema can't
carry. By contrast, `ClaimGroup.description`/`.claimIds` (no dedicated
column, but `SurfaceClaimGroup` does have a generic `metadata` JSONB column)
are preserved losslessly via a reserved metadata sub-key instead of failing —
there is a safe place to put them. `Claim.value` has no persisted channel at
all (Surface's `Evidence`/`VerificationEvent` carry no generic "asserted
value" field); `loadClaimBundle` always reconstructs `value: undefined`,
which is safe because `foldClaim`/`deriveClaimStatus`/`deriveTrustSnapshot`
derive status from claim identity/timestamps/events/evidence/policy, never
from `.value` — the live Camp/Session column remains the source of truth for
what was actually asserted (`coverageFromRollup(rollup, campValues)` reads it
from there, not from the ClaimStore).

## Backfill

`scripts/backfill-claim-store.ts` (`lib/admin/claim-store-backfill.ts`'s
`backfillClaimStore({ dryRun })`) is a one-time, idempotent projection of the
two previously-unreconciled legacy attestation stores into migration 012's
tables:

1. **`Camp.fieldSources`** (JSONB, last-write-wins — one entry per field, no
   history) projects to exactly one deterministic Evidence + one
   deterministic VerificationEvent per field, keyed off
   `campCanonicalClaimId`. `attestedBy` present → `human_attestation`-flavored
   evidence; absent → `crawl_observation`-flavored.
2. **`FieldAttestation`** (append-only — a Camp field can accumulate many
   rows over time) projects each row to its **own** Evidence + Event, keyed
   by the row's own `id` (deterministic and stable across re-runs).
   `ACTIVE` → `verified`; `STALE` → `stale` + an invalidation note;
   `INVALIDATED` → `revoked` + reason.

**Idempotency.** `persistClaim` already upserts (`ON CONFLICT ("id") DO
UPDATE`), so a Claim row never duplicates. `appendEvidence`/`appendEvent` are
deliberately append-only with no `ON CONFLICT` path (corrections are new
rows, never mutations, by migration 012's own design), so the backfill
itself keys every Evidence/Event id deterministically off the legacy row it
came from and checks existence before inserting — a second run writes zero
additional rows.

**Scope + skipped-and-counted gaps.** Only `entityType: 'CAMP'` rows, and
only the 8 `VERIFIED_CAMP_FIELDS` — the only fields with a ratified
claim-identity/claim-type/policy convention in this slice. `PROVIDER`/
`PERSON` `FieldAttestation` rows and non-canonical `fieldKey` values (e.g.
`schedules`, `ageGroups:<id>`, `pricing:<id>`, `provider`, `people`) have no
Surface claim subject/type/policy defined anywhere in this slice; projecting
them would mean inventing new claim vocabulary outside this delivery's
ratified decisions. They are **skipped and counted**
(`BackfillSummary.fieldSourcesSkipped`/`fieldAttestationsSkipped`), never
silently dropped — a future slice that ratifies claim vocabulary for those
fields can extend this module's scope. `Claim.value`/
`FieldAttestation.valueSnapshot` are not projected anywhere, for the same
"no persisted value channel" reason described above.

## Writer cutovers

All four AC4 writer call sites, plus `review-apply.ts`'s verification
cutover, now record real Evidence and let the evaluator derive the result —
**zero routes write `Camp.dataConfidence` directly**:

| Call site | Before | After |
| --- | --- | --- |
| `app/api/admin/camps/[campId]/route.ts` `mark_verified` | Unconditional `UPDATE ... dataConfidence='VERIFIED'` | `bulk-attestation.ts`'s `bulkAttestCamp` — one `human_attestation` Evidence per required field via Surface's `buildHumanAttestationEvidence`, `recordEvidence` each, `refreshCampVerificationCache`; the route returns the *derived* outcome, not an assumed one. |
| `app/api/admin/assistant/route.ts` `mark_camp_verified` | Unconditional `UPDATE ... dataConfidence='VERIFIED'` | Same shared `bulkAttestCamp` path; the assistant's reply string reports the real outcome (`"Attested N required fields; M still need data..."`) when the result isn't actually `VERIFIED`, instead of unconditionally claiming success. |
| `app/api/admin/camps/[campId]/attest/route.ts` | Wrote `fieldSources` JSON + `lastVerifiedAt` only, no evaluator | `entity-admin-repository.ts`'s `recordCampAttestationEvidence` — consumes `trust-projection.ts`'s `buildCampAttestationTrustInput` output (previously built and discarded) through `recordEvidence`, then `refreshCampVerificationCache`. The `fieldSources` JSON write is **kept** (legacy, rollback path). |
| `app/api/admin/entities/[entityType]/[entityId]/route.ts` `attest` action / `addFieldAttestation` | Wrote a `FieldAttestation` row only | For `entityType === 'CAMP'` and `fieldKey` in the Verified Camp Claim Set: **also** calls `recordCampAttestationEvidence` (dual-write — the `FieldAttestation` row is still written, unaffected). For `PROVIDER`/`PERSON` entities and CAMP fields outside the claim set (`organizationName`, `applicationUrl`, indexed sub-fields, etc.): **unchanged**, `FieldAttestation`-only. |
| `lib/admin/review-apply.ts` `recomputeVerification` | Read `isFullyVerified`, wrote `dataConfidence` conditionally | **Deleted.** `buildCampReviewTrustInput`'s previously-discarded result now feeds `recordAppliedFieldEvidence` (applied fields only; rejected fields leave Current Value claims untouched) post-`COMMIT`, then `refreshCampVerificationCache` — runs for both full and `keepPending` applies. |

**Dual-write posture for legacy stores.** `Camp.fieldSources` and
`FieldAttestation` both stay fully readable — this slice's stance is
cutover-with-backfill for *new* evidence recording plus a one-time backfill
of *existing* legacy data, never a silent retirement of either store. This
is the explicit rollback path decision 2 calls for.

**`app/admin/trust/page.tsx` — unchanged, by design.** It reads
`FieldAttestation` only (`getTrustDashboard()`). Per decision 2/3,
`FieldAttestation` stays the legacy, rollback-readable store;
`recordCampAttestationEvidence` dual-writes it for CAMP claim-set fields (via
`addFieldAttestation` still being called), and it is untouched for
everything else. This page is **not** migrated to read the ClaimStore-backed
tables in this slice — an explicit, accepted gap (not a silent omission): a
natural follow-up once the ClaimStore is proven as sole authority, deferred
here because adding a 4th consumer to migrate would enlarge an
already-largest-in-repo-history single delivery.

## Stable Sessions

`lib/admin/session-identity.ts` gives `CampSchedule` ("Session") rows stable
identity across Reviews, replacing `applyRelationField`'s prior
delete-all-then-insert for the `schedules` relation only (`ageGroups`/
`pricing` are untouched, still delete-all+insert — decision 5 scopes the
keyed-upsert change to `schedules` only).

- **Natural key.** Trimmed, case-insensitive `label` + `startDate` +
  `endDate` — the natural key a human/crawl already treats as "the same
  session" (two sessions never share a label AND date range in existing
  crawl data; `label` is required non-null on every Proposal-carried
  schedule). `applyScheduleReconciliation` reads existing non-archived rows,
  matches them against the incoming snapshot via `@kontourai/surface`'s
  `matchClaimSubjects` (consumed directly, not reimplemented), then
  translates the `{matched, orphaned, created}` result into SQL.
- **Archive-not-delete.** Matched rows are `UPDATE`d in place (id preserved).
  Rows with no incoming match this round are `UPDATE "CampSchedule" SET
  "archivedAt" = now()` — never `DELETE`d. Unmatched incoming rows are
  freshly `INSERT`ed. A `CampSchedule.id` observed across two sequential
  Review Applies for the "same" session (same label + dates) is identical.
- **Revocation wiring.** `@kontourai/surface`'s
  `deriveOrphanedSubjectDisposition` (consumed via
  `session-identity.ts`'s `deriveArchivedSessionDisposition`) produces a
  `revoked` `VerificationEvent` for every Claim belonging to an archived
  Session. `verification-authority.ts`'s `revokeArchivedSessionClaims`
  bridges this pure disposition function to the actual read
  (`loadClaimBundle`) + append (`appendEvent`) round-trip — it only revokes
  Claims that are **already persisted** for the archived Session; a Session
  archived before any Claim was ever persisted for it produces no events, a
  safe no-op rather than a silent failure (nothing yet calls `persistClaim`
  eagerly for Session Attribute Claims — they are synthesized on read, per
  the module interface section above). The Camp's `sessions-verified`
  Claim's `derivedFrom` list is rebuilt from current non-archived rows on
  every evaluation, so an archived Session automatically drops out of the
  Camp's rollup — no separate "recompute derivedFrom" step is needed.

## Semantic finding: legacy-only evidence derives PLACEHOLDER (ops-relevant)

This is the single most important operational fact this slice surfaced, and
it is a genuine behavior change, not a bug. (V7 fix, review-code.md MEDIUM:
this used to be advisory-only, with no concrete tooling to quantify the
blast radius before deploy — `lib/admin/claim-store-backfill.ts`'s
`buildDowngradeImpactReport`, wired into `scripts/backfill-claim-store.ts`'s
`--report`/`--dry-run` flags, is that tooling; see the Ops runbook's step 4
below, now a required pre-deploy step rather than a "consider" suggestion.)

**Policies require both `crawl_observation` and `human_attestation` evidence
types for a Camp scalar/repeated field claim to reach `verified`**
(`policy.camp.scalar-field`/`policy.camp.repeated-field`'s
`requiredEvidence`). Neither legacy source ever produces
`human_attestation`-typed evidence: `Camp.fieldSources` produces
`crawl_observation` or plain `attestation` (depending on whether
`attestedBy` was set), and `FieldAttestation` rows likewise never carry the
Surface `human_attestation` evidence type. The backfill's own integration
test proves this directly: backfilling a legacy-shaped Camp (fieldSources +
FieldAttestation across all 8 fields) and then calling
`deriveCampVerification` with **zero** manual claim writes correctly yields
`proposed`/`PLACEHOLDER`, not `verified`.

**Operational implication:** a Camp that currently shows `dataConfidence:
'VERIFIED'` purely from legacy-store history (no fresh admin attestation or
crawl recorded through the new claim-store path) **may downgrade to
`PLACEHOLDER`** the next time its verification cache is refreshed (any
Review Apply, any new attestation on any one of its fields, any future bulk
recheck). This is the evaluator behaving honestly against a stricter,
auditable policy — not a regression to hide or suppress. It is the direct
consequence of moving from "a human once flipped a boolean" to "Surface's
policy requires both a crawl-derived and a human-attested evidence type."

**Why admin bulk attestation doesn't hit this wall.** A fresh admin
attestation (via `mark_verified`/`mark_camp_verified`/the `/attest` route)
records real, human-backed Evidence, but `recordEvidence`'s *default* event
synthesis would set `status: 'verified'` for `method: 'attestation'`
evidence — which the same `requiredEvidence` check would immediately demote
back to `proposed` (no crawl evidence exists). `bulk-attestation.ts` avoids
this by passing an **explicit `status: 'assumed'`** `VerificationEvent`
instead, which `deriveTrustStatus` accepts unconditionally, bypassing the
evidence-type gate entirely — the same convention `trust-projection.ts`'s
Survey-flavored builders and `recordCampAttestationEvidence` already use for
admin-only attestation. This is not a weaker outcome: `deriveClaimGroupRollups`'s
requirement-status aggregation **promotes an all-`assumed` requirement to
`verified`**, so a fully-attested, zero-Session Camp still derives
`dataConfidence: 'VERIFIED'` end-to-end through
`refreshCampVerificationCache`.

## Accepted gaps

- **`PROVIDER`/`PERSON` + non-claim-set fields stay legacy-only.**
  `FieldAttestation` rows for `PROVIDER`/`PERSON` entities, and CAMP fields
  outside the ratified claim set (`organizationName`, `applicationUrl`,
  indexed sub-fields), are neither backfilled nor dual-written going
  forward — no Surface claim vocabulary exists for them this slice. Recorded,
  not silently dropped; a future slice that ratifies claim vocabulary for
  them can extend this module.
- **`sourceType='SCRAPER'` no longer written anywhere.** An intentional scope
  drop surfaced during `review-apply.ts`'s cutover; flagged during execution,
  not fixed here.
- **`recordEvidence` is not transactional.** Its three writes (claim,
  evidence, event) each commit independently — a crash between steps could
  leave a Claim persisted without its intended Evidence/Event. Composing it
  into one larger caller-managed transaction would need a bigger refactor
  than this module's scope; accepted, recorded above under ClaimStore
  materialization.
- **A zero-Session Camp trivially verifies `sessions-verified`.** With no
  non-archived Sessions, the Camp's rollup Claim has an empty `derivedFrom`
  list and resolves to `verified` by default — documented behavior, not an
  oversight, and covered by an explicit test case.
- **`Camp.updatedAt` is not bumped by `mark_verified`/bulk attestation.**
  Only `dataConfidence`/`lastVerifiedAt` are written by
  `refreshCampVerificationCache`; any UI or downstream consumer that treats
  `updatedAt` as "last touched at all" will not see a bulk-attestation event
  reflected there. Checked specifically against `review-repository.ts`'s
  `getUnverifiedCamps` (`ORDER BY c."dataConfidence" ASC, c."updatedAt" ASC`)
  — the one place `updatedAt` feeds an ordering: low impact, since a
  just-verified Camp already drops out of that query's `dataConfidence`-based
  filtering regardless of its `updatedAt` value.
- **`app/admin/trust/page.tsx` stays on legacy `FieldAttestation` reads** —
  see Writer cutovers above.

## Upstream opportunities

Verbatim from the plan (`.kontourai/flow-agents/verification-authority/verification-authority--deliver-plan.md`),
including the user's decision-8 override struck through and replaced:

| # | Candidate | Verdict | Reasoning |
| --- | --- | --- | --- |
| 1 | Pluggable Postgres/SQL `ClaimStore` storage adapter | ~~Local-first, extraction note recorded~~ → **UPSTREAMED NOW (decision 8 override, 2026-07-03)** — see `surface-store-adapter--deliver-plan.md` PR1 | Genuine gap: `store.d.ts`/`claim-store-transactions.d.ts` are file-path-only (`loadClaimStore(path)`); no storage-port seam exists (`adapter.d.ts`'s `Adapter.adapt(record): TrustBundle` is an *ingestion*-format adapter, a different concern, not storage). The planner's original reasoning (CampFit is the only consumer today; premature abstraction; upstream PR+release cycle risks this delivery's critical path) is preserved above as context, but the user explicitly overrode it: CampFit is the reference consumer, and the seam + a Postgres reference implementation are being built in `@kontourai/surface` now, sequenced before this plan's Wave 2 `claim-store.ts` task. |
| 2 | Requirement-set/rollup composition across subjects (Camp requires verified Sessions) | **No fork — reused as designed, not a gap** | `derivedFrom`/`derivationEdges` + `applyDerivation`'s ceiling function (`derivation.d.ts`) is the documented mechanism for "a derived claim cannot be more confident than the weakest claim it is built on," and `deriveTrustSnapshot` already runs fold + derivation + `deriveClaimGroupRollups` over one bundle (`trust-snapshot.d.ts`). CampFit's only local work is minting one synthesized per-Camp/per-Session rollup claim per subject and listing it as an input — exactly the intended composition, not a missing capability. |
| 3 | Stable-id matching for rewritten child-entity rows (the Session upsert problem) | ~~Local-first, extraction note recorded~~ → **UPSTREAMED NOW (decision 8 override, 2026-07-03)** — see `surface-store-adapter--deliver-plan.md` PR2 | Genuine gap, but not a Surface gap in the sense of "belongs in `identity.ts`": Surface's `identity.d.ts` (`IdentityLink`/`buildIdentityIndex`) solves cross-*producer* subject coreference (the same real-world entity claimed by two different producers), a different problem from "match this Review's incoming child-row list to existing DB rows by natural key." It DOES belong in Surface as a NEW file (`claim-subject-matching.ts`), not Survey, because the disposition half of the contract hangs off Surface's own `VerificationEvent`/`TrustStatus` vocabulary. The planner's original reasoning (single consumer, premature generic interface) is preserved above as context, but the user explicitly overrode it: CampFit is the reference consumer for `matchClaimSubjects`/`deriveOrphanedSubjectDisposition`, built in `@kontourai/surface` now, sequenced before this plan's Wave 2 session-identity task. |
| 4 | Derived-cache projection helper (`TrustStatus` → product enum, with refresh semantics) | **No fork for the generic half; local for the product half** | The generic "cost-bounded cache with refresh semantics" is already shipped: `DerivationCheckpoint` + `deriveTrustSnapshot`'s `since` option (`trust-snapshot.d.ts`) is exactly a checkpoint/refresh mechanism. The enum-COLLAPSE mapping (`verified→VERIFIED`, `stale→STALE`, everything else→`PLACEHOLDER`) is inherently CampFit's own 3-value vocabulary — there is nothing generic left to extract once the checkpoint mechanism (already generic, already upstream) is factored out. |
| 5 | Survey server-review-session support for child-entity-scoped review items (session-level evidence capture) | **No fork — reused as designed, not a gap** | `ReviewItemSpec.target`/`ReviewItemStatus` (`review-resource.d.ts`) are already keyed by an opaque `target: string` following the canonical claim grammar (`subjectType.subjectId.fieldOrBehavior`), with no assumption that a review's subjects are all the same entity type. CampFit mints session-scoped targets (e.g. `public-directory.camp-session.<scheduleId>.dates`) using the existing mechanism; no new Survey capability required. |

CampFit contains no local redefinition of `interface ClaimStoreAdapter`,
`function matchClaimSubjects`, or `function deriveOrphanedSubjectDisposition`
— `lib/admin/claim-store.ts` and `lib/admin/session-identity.ts` import both
from `@kontourai/surface` (`^2.3.0`) directly.

## Ops runbook

0. **Connection safety (V6, security review SF2).** `scripts/backfill-
   claim-store.ts` now REFUSES to run at all — for `--dry-run` or a real
   write alike — unless the connection it resolves (`DATABASE_URL`/
   `POSTGRES_URL`/`PGHOST` — the script loads `.env.prod` first, matching
   every other script in this repo) looks like the throwaway
   `TEST_DATABASE_URL`-shaped test database (loopback host, `sslmode=disable`,
   `"test"` in the database name). This closes the "a local `.env.prod` +
   bare invocation reads/writes production" hazard the security review
   flagged (SF2). Pass `--allow-production` to run against the real Supabase
   instance deliberately — the one, human-run production cutover this
   runbook exists for.
1. **Apply migration 012 to production.** It is additive-only (new tables +
   nullable columns) and idempotent (`IF NOT EXISTS` throughout) — safe to
   run against the real Supabase instance exactly like migrations 001-011
   before it, human-run and out of band from this repo's automated
   test/verify commands (this delivery's automated commands only ever touch
   the throwaway `TEST_DATABASE_URL` Postgres).
2. **Run the backfill dry-run first**: `npm run backfill:claim-store:dry`
   (`scripts/backfill-claim-store.ts --dry-run`) reports the Claim/
   Evidence/Event row counts it *would* write, plus the
   `fieldSourcesSkipped`/`fieldAttestationsSkipped` counts for
   non-claim-set/non-CAMP rows, without writing anything. `--dry-run` also
   always runs the downgrade-impact report (step 4 below) — see it before
   deciding whether to proceed.
3. **Run the real backfill**: `npm run backfill:claim-store` (pass
   `--allow-production` against the real Supabase instance, per step 0).
   Safe to re-run — idempotent by construction (see Backfill section
   above). Confirm row counts stabilize on a second run.
4. **Required pre-deploy step (V7): run the downgrade-impact report and
   review its output before deploying this slice** —
   `npx tsx scripts/backfill-claim-store.ts --report --dry-run` (or just
   `--dry-run`, which implies `--report`; `--allow-production` needed
   against the real instance). This calls `lib/admin/claim-store-
   backfill.ts`'s `buildDowngradeImpactReport`: for every Camp CURRENTLY
   `dataConfidence: 'VERIFIED'`, it derives what `refreshCampVerification-
   Cache` would compute for it today (read-only — writes nothing) and lists
   every Camp where the two disagree, with counts. Per the Semantic finding
   below, any Camp whose `VERIFIED` status rests solely on legacy-store
   evidence (no crawl-derived evidence recorded through the new path) WILL
   derive `proposed`/`PLACEHOLDER` the next time `refreshCampVerification-
   Cache` runs for it (any Review Apply, any new attestation on any one of
   its fields, any future bulk recheck) — this is expected, honest behavior
   per ADR-0002, not an incident, but this report turns "consider auditing
   this" into a concrete, reviewable list an operator sees BEFORE deploying,
   so admin-facing surfaces aren't surprised by an unannounced wave of
   coverage-meter/badge changes.

## Test approach

`tests/integration/verification-authority.test.ts` extends the same
real-Postgres integration-test infrastructure `docs/review-apply-module.md`
documents (`tests/integration/global-setup.ts`/`test-db.ts`'s env-var-remap
isolation, `TRUNCATE`-per-test, the `_campfit_test_db_marker` F1
defense-in-depth) — no new isolation mechanism was needed for this slice's
additional tables. `scripts/test-db-reset.ts`'s `SCHEMA_FILES` appends
migration 012 last (after 011); ordering relative to 005-011 does not matter
beyond "after `CampSchedule`/`CampPricing` exist" (created in migration
001), already satisfied. As of this slice's Wave 5, both
`verification-authority.test.ts` and `review-apply.test.ts` have zero
`it.todo` placeholders remaining and cover every AC2-AC7 case named in the
plan's Definition Of Done, including the all-9-`TrustStatus`-inputs mapping
table and the disputed-Session-caps-Camp rollup case.
