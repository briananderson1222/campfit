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
`registrationStatus` observations are still assembled locally. Aggregate
`schedules` observations use `@kontourai/survey`'s `repeatedObservation`
helper so Campfit keeps schedule policy and validation while Survey owns the
generic repeated-value provenance shape.

## What This Proves

- Campfit has the same Survey-shaped spine as the tax repo: raw source,
  extraction, candidate proposal, review, and verified claim material.
- The source locator is web/excerpt based, not PDF or tax-form based.
- `registrationStatus` can be represented as a Surface field claim with
  `crawl_observation` evidence.
- `schedules` can be represented as an aggregate repeated-field claim with
  the current approved schedule set and pending candidate schedule set.
- A pending crawl proposal can be represented as a proposed candidate claim,
  separate from the currently approved field claim.
- Campfit relation approvals must write `fieldSources.schedules`; replacing
  relation rows without source coverage makes downstream trust export weaker
  than scalar-field export.

## What Moved To Survey

The aggregate repeated-field observation shape moved into Survey:

- one source/excerpt supporting a list of current or candidate rows
- shared `metadata.survey.repeated = { representation: "aggregate-array",
  itemCount }`
- default extraction target, claim field, array value, and empty-array support

Campfit now supplies the Campfit-specific parts to that helper: claim ids,
claim types, schedule candidate validation, field-source approval semantics,
proposal status mapping, and `metadata.campfit`. Generic repeated-array
metadata belongs under `metadata.survey.repeated`, not `metadata.campfit`.

## What Should Eventually Move To Survey

These concepts are still candidates for extraction after more vertical proofs:

- raw source identity conventions: source URL, crawl/proposal id, observed time
- resolution/proposal result helpers: old value, new candidate, confidence,
  rationale
- review/promotion result helpers: approved field source, rejected proposal,
  pending candidate
- Surface adapter mapping shortcuts that reduce scalar field boilerplate without
  hiding producer discipline

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
