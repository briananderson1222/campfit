---
status: current
subject: Verified Session Claim Set
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0002-verified-camp-session-claim-sets.md
  - kind: doc
    ref: docs/verification-authority.md
---
# Verified Session Claim Set

Previously no `CampSchedule` row carried a verification claim of its own —
session rows were replaced wholesale (delete-all + insert new UUIDs) on every
Review Apply, so nothing durable could be a claim subject even if one
existed. This decision defines what a Verified Session requires and how a
`CampSchedule` row becomes a stable, evidence-bearing claim subject.

**The claim set (6 requirements).** Per ADR-0002, a Verified Session requires:
session dates, session time (or an explicit, recorded reason time does not
apply), eligibility, registration status, price options, and registration
path — each expressed as its own Surface claim type with an explicit
Verification Gap recorded when a required value is unknown, rather than the
claim silently reading as unverified with no record of why. These 6 claim
types are added to `lib/trust-vocabulary.ts`'s `campfitVocabulary` under a new
`session` subject type (`campfitSessionVocabulary`, `public-directory.camp-
session`), additive alongside the existing camp-scoped claim ids — no
existing `scalarField`/`repeatedField` entry is touched.
`lib/admin/verification-policy.ts`'s `buildVerifiedSessionClaimGroup` builds
the 6-requirement `ClaimGroup`; only `dates` and `time` carry real per-Session
evidence sourced from the `schedules` relation-field diff. The remaining 4
(`eligibility`, `registration-status`, `price-options`, `registration-path`)
are `inheritedByDefault: 'camp-level'` — `lib/admin/verification-
authority.ts`'s `buildInheritedSessionClaims` synthesizes a Session-scoped
Claim from the corresponding verified Camp-level claim
(`metadata.inherited: 'camp-level'`, `derivedFrom` pointing at the Camp
claim), an explicit and inspectable gap rather than a silent default.

**Session rows become stable claim subjects.** For a `CampSchedule` row to
carry claims and evidence across Reviews, its identity must survive a Review
Apply rather than being deleted and recreated. Review Apply's `schedules`
relation-write moved from delete-all+insert to a keyed upsert
(`lib/admin/session-identity.ts`, wrapping Surface's `matchClaimSubjects` +
`deriveOrphanedSubjectDisposition`, wired into `lib/admin/review-apply.ts`'s
`schedules` branch): incoming sessions are matched to existing rows by
(trimmed, lowercased) `label` + `startDate` + `endDate`; matches update in
place (preserving `id`); unmatched existing rows are archived
(`CampSchedule.archivedAt` set, never hard-deleted, so their claim history is
not orphaned mid-air); unmatched incoming rows are inserted as new subjects.
`ageGroups` and `pricing` relation-writes are unaffected — this change is
scoped to `schedules` only. Archived sessions drop out of a camp's
`sessions-verified` rollup automatically (the rollup is computed over
non-archived sessions only; migration 012 has no `derivedFrom` column, so
rollup/inherited claims are synthesized in-memory per evaluation rather than
persisted).

**Rollup into the Verified Camp Claim Set.** A camp's `sessions-verified`
claim (see `verified-camp-claim-set.md`) is a rollup over its non-archived
sessions' own Verified Session status, folded via `applyDerivation`'s
weakest-link ceiling — a camp cannot be Verified while any of its current
sessions are not. A disputed Session claim (e.g. `dates`) caps both that
Session's own rollup and the Camp's `sessions-verified` requirement at
`disputed`, never silently reading as `verified`.

This decision is implemented by migration `012_claim_store_and_session_
identity.sql` (`CampSchedule.archivedAt`), `lib/admin/session-identity.ts`,
the `schedules` branch of `lib/admin/review-apply.ts`, `lib/trust-
vocabulary.ts`'s `campfitSessionVocabulary`, and `lib/admin/verification-
policy.ts`/`lib/admin/verification-authority.ts`, and is proven by `tests/
integration/verification-authority.test.ts` (30/30 passing, including
Session claim-group assertions and disputed-session-caps-camp coverage) and
`tests/integration/review-apply.test.ts`'s keyed-upsert id-preservation/
archive-not-delete assertions across sequential Reviews. See `docs/
verification-authority.md` for the durable architecture note and the
archived `.kontourai/flow-agents/verification-authority/` session for full
execution history.
