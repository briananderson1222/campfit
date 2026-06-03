# Surface Trust Export Proof

Status: proof slice. Created 2026-05-31.

This repo now has a public-directory proof that maps scalar and repeated-field
provenance into a Surface `TrustInput`:

```text
camp website / schedule URL
  -> crawl extraction
  -> review proposal
  -> approved fieldSource
  -> Surface public-data field or repeated-field claim
```

The implementation lives in `lib/surface-trust-export.ts`. Scalar
`registrationStatus` observations use `@kontourai/survey`'s
`sourceOfAuthorityObservationBuilder` because the camp publisher page is the
declared source of authority for that registration value. Aggregate `schedules`
observations still use Survey's `repeatedObservation` helper so they preserve
repeated-array metadata. URL-backed raw-source shape uses Survey's
`webPageSource` helper. Campfit keeps field policy, validation, source ids,
claim ids, and review semantics while Survey owns the generic observation
shape.

Admin review and manual attestation guards live in
`lib/admin/trust-projection.ts`. They use the same shared Campfit trust
vocabulary from `lib/trust-vocabulary.ts` so public exports and admin decisions
agree on subject type, Surface name, claim types, and review decision effects.

`lib/admin/trust-projection.ts` also proves the reviewed current/proposed
resolution shape from Survey. Campfit authors both observations because it owns
the current record, crawler proposal, field policy, claim ids, and learning
signals. Survey combines those observations into one candidate set, records
which candidate was selected, promotes the selected candidate to the canonical
field claim, and keeps the unselected candidate inspectable as proposal history.

## What This Proves

- Campfit has the same Survey-shaped spine as the tax repo: raw source,
  extraction, candidate proposal, review, and verified claim material.
- The source locator is web/excerpt based, not PDF or tax-form based.
- `registrationStatus` can be represented as a source-authority-backed Surface
  field claim with `crawl_observation` evidence and evidence metadata under
  `sourceAuthority`.
- `schedules` can be represented as an aggregate repeated-field claim with
  the current approved schedule set and pending candidate schedule set.
- A pending crawl proposal can be represented as a proposed candidate claim,
  separate from the currently approved field claim.
- Campfit relation approvals must write `fieldSources.schedules`; replacing
  relation rows without source coverage makes downstream trust export weaker
  than scalar-field export.
- A rejected crawl proposal is a rejected candidate claim, not a rejected
  current field claim. In Campfit it means the reviewer kept the current value;
  the decision is marked with `decisionEffect: "kept-current-value"` so it can
  feed future extraction prompt/eval refinement.
- Final rejected candidates also emit `field_rejection_learning_signal`
  `CrawlMetric` rows. Those rows carry the kept current value, rejected
  candidate value, source URL/excerpt, confidence, model, reviewer notes, and
  feedback tags so extraction failures can be turned into prompt/eval fixtures.
- Survey's `reviewedCurrentProposedResolution` helper is the right current API
  for this proof. Campfit still decides whether approval means "accept proposed"
  or "keep current", but Survey owns the portable selected/unselected candidate
  wiring. The selected candidate receives the review outcome id; the unselected
  candidate remains tied to the same candidate set and keeps its candidate
  status for audit and learning.

## What Moved To Survey

The generic scalar and aggregate repeated-field observation shapes moved into
Survey:

- web-page raw-source shape/defaults for URL-backed crawl and proposal evidence
- one source-authority builder path for publisher-backed current or candidate
  registration values
- one source/excerpt supporting a list of current or candidate rows
- shared `metadata.survey.sourceOfAuthority = { authorityClass }`
- shared `metadata.survey.repeated = { representation: "aggregate-array",
  itemCount }`
- default extraction target, claim field, scalar/list value, and empty-array
  support

Campfit now supplies the Campfit-specific parts to those helpers: claim ids,
claim types, registration status validation, schedule candidate validation,
field-source approval semantics, proposal status mapping, and
`metadata.campfit`. Generic scalar metadata belongs under
`metadata.survey.field`; generic repeated-array metadata belongs under
`metadata.survey.repeated`.

## What Should Eventually Move To Survey

These concepts are still candidates for extraction after more vertical proofs:

- raw source identity conventions: source URL, crawl/proposal id, observed time
- resolution/proposal result helpers: old value, new candidate, confidence,
  rationale
- Surface adapter mapping shortcuts that reduce producer boilerplate without
  hiding producer discipline

Do not move Campfit's current/proposed policy into Survey yet. Survey can own
the candidate-set mechanics, but Campfit must keep the rules that decide which
fields are reviewable, which proposal modes are valid, when rejection means
"keep current value", how learning signals are recorded, and which claim ids
are canonical versus proposal-specific.

Campfit should keep:

- camp/provider domain model and admin workflows
- crawl target selection and scraping strategy
- field display labels and directory UX
- array-field semantics for schedules, pricing, and age groups

## Current Limitation

The schedule proof is intentionally aggregate-level: one `fieldSources.schedules`
entry supports the schedule list. That matches the current Campfit review data,
but it does not prove independent source/review lineage per schedule row.
An approved empty schedule list is still exported as a verified repeated-field
claim, because "reviewed and no schedules available" is meaningful provenance.

`CampSchedule.id` is also not a durable provenance key because approval replaces
relation rows. A future per-row proof should use semantic row keys built from
label/date/time fields and carry database ids as metadata only.

Pricing remains deferred. It adds normalization and policy questions around
units, discounts, free/TBD values, and duration semantics. Schedules are the
cleaner repeated-entity proving ground first.
