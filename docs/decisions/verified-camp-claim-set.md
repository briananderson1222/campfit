---
status: current
subject: Verified Camp Claim Set
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0002-verified-camp-session-claim-sets.md
  - kind: doc
    ref: docs/verification-authority.md
---
# Verified Camp Claim Set

A Verified Camp is the aggregate of a fixed **claim set**, not a single
manually-set flag. Verification status is delegated to `@kontourai/surface`'s
evaluator (`deriveClaimStatus` / `foldClaim` / `deriveTrustSnapshot`); CampFit's
job is to express *what* must be true — the Verified Camp Claim Set — as
Surface `ClaimGroup`/`VerificationPolicy` data (`lib/admin/verification-
policy.ts`), and to keep that data current as evidence is recorded
(`lib/admin/verification-authority.ts`). The prior `lib/admin/verification.ts`
(`REQUIRED_FOR_VERIFIED` constant and its coverage-percentage math) is deleted;
`Camp.dataConfidence` and `lastVerifiedAt` are a derived cache of the
evaluator's output, refreshed by `refreshCampVerificationCache` — the sole
writer of `Camp.dataConfidence` in the codebase.

**The claim set (9 requirements).** The prior `REQUIRED_FOR_VERIFIED` list
(`description`, `campType`, `category`, `registrationStatus`, `city`,
`websiteUrl`, `ageGroups`, `pricing` — 8 fields, exported now as
`VERIFIED_CAMP_FIELDS`) is carried forward with one substitution: `schedules`
(presence of `CampSchedule` rows) is replaced by a `sessions-verified` claim.
A camp's session-presence requirement is no longer "does at least one
schedule row exist" but "are the camp's sessions themselves verified," which
composes the Verified Camp Claim Set with the Verified Session Claim Set as a
parent/child rollup (`deriveCampVerification`'s per-Session `ClaimGroupRollup`
folded via `applyDerivation`'s weakest-link ceiling) — a camp cannot be
Verified while it has a non-archived session that is not. A zero-session camp
trivially satisfies `sessions-verified` (documented default). The remaining 8
claims map 1:1 onto the existing fields and correspond to ADR-0002's identity
(`description`, `campType`/`category`), location (`city`), and
contact-or-registration-path (`websiteUrl`, `registrationStatus`,
`ageGroups`, `pricing`) claim families.

**One `VerificationPolicy` per claim type.** Each of the 8 field claims gets
its own `VerificationPolicy` in `lib/admin/verification-policy.ts` (required
evidence, acceptance criteria, review authority, staleness/conflict rules,
impact level) rather than one blanket attestation rule for the whole camp —
this is what lets a crawl-sourced field and a human-attested field satisfy the
same claim through different evidence paths, and what lets the policy module
stay pure, DB-free data consumed by the evaluator. Every one of the 8 field
policies requires **both** `crawl_observation` and `human_attestation`
evidence types before a claim can reach `verified` status.

**Writers become evidence recorders, not verdict setters.** The camp-editor
"Mark Verified" action and the assistant's `mark_camp_verified` tool no longer
write a `dataConfidence` verdict directly; both route through
`lib/admin/bulk-attestation.ts`'s `bulkAttestCamp`, which records Attestation
evidence per required claim (`buildHumanAttestationEvidence`, unmodified from
Surface, content-hashed) and calls `refreshCampVerificationCache` to derive
the resulting `dataConfidence`. The `/attest` route and the generic entity
`attest` action dual-write the same way for `CAMP` claim-set fields
(`recordCampAttestationEvidence` in `lib/admin/entity-admin-repository.ts`),
alongside the pre-existing `FieldAttestation` row (kept as the legacy/rollback
store; the Trust page is unaffected). `review-apply.ts`'s
`recomputeVerification` is retired in favor of the same
`refreshCampVerificationCache` call, fed by `buildCampReviewTrustInput`'s
evidence for applied fields only.

**Honest derivation, not an unconditional "verified" claim (real finding).**
Because every field policy requires both `crawl_observation` and
`human_attestation` evidence, evidence sourced from only one channel cannot
reach `verified` on its own:

- Legacy-only evidence — the backfill (`scripts/backfill-claim-store.ts`,
  `lib/admin/claim-store-backfill.ts`) maps historic `fieldSources` and
  `FieldAttestation` rows into `crawl_observation`/`attestation`-typed
  evidence, never `human_attestation` — correctly derives `proposed` /
  `PLACEHOLDER`, not `verified`, for a camp backfilled with no new manual
  claim writes. This is the evaluator behaving honestly per ADR-0002, not a
  bug: a currently-VERIFIED camp under the old flag-based model may downgrade
  to `PLACEHOLDER` the next time its cache is refreshed from legacy evidence
  alone, until it is re-attested.
- Fresh admin attestation alone likewise cannot reach `verified` through
  `human_attestation` evidence in isolation; `bulkAttestCamp` records
  `assumed`-status events instead, and the rollup promotes an all-`assumed`,
  gap-free claim set to `verified` — matching the existing
  `trust-projection.ts` convention rather than forking a new one.

Both findings are the same policy design applied consistently across the
backfill path and the live-write paths.

**Enum projection.** `projectTrustStatusToDataConfidence`
(`lib/admin/verification-policy.ts`) maps all 9 Surface `TrustStatus` values
onto the 3-value `DataConfidence` column: `verified` → `VERIFIED`, `stale` →
`STALE`, everything else (`proposed`, `assumed`, `disputed`, `superseded`,
`rejected`, `revoked`, and unknown) → `PLACEHOLDER`, matching the column's
existing `DEFAULT`.

This decision is implemented by migration `012_claim_store_and_session_
identity.sql`, `lib/admin/verification-policy.ts`, `lib/admin/verification-
authority.ts`, `lib/admin/bulk-attestation.ts`, `lib/admin/claim-store.ts`,
`lib/admin/claim-store-backfill.ts`, and is proven by `tests/integration/
verification-authority.test.ts` (30/30 passing) plus the updated `tests/
integration/review-apply.test.ts` assertions. See `docs/verification-
authority.md` for the durable architecture note (enum mapping table, session
inheritance detail, upstream-opportunities analysis) and the archived
`.kontourai/flow-agents/verification-authority/` session for full execution
history.
