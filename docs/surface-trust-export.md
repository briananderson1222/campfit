# Surface Trust Export Proof

Status: proof slice. Created 2026-05-31.

This repo now has a narrow registration-status proof that maps public-directory
field provenance into a Surface `TrustInput`:

```text
camp website URL
  -> crawl extraction
  -> review proposal
  -> approved fieldSource
  -> Surface public-data field claim
```

The implementation lives in `lib/surface-trust-export.ts`.

## What This Proves

- Campfit has the same Survey-shaped spine as the tax repo: raw source,
  extraction, candidate proposal, review, and verified claim material.
- The source locator is web/excerpt based, not PDF or tax-form based.
- `registrationStatus` can be represented as a Surface field claim with
  `crawl_observation` evidence.
- A pending crawl proposal can be represented as a proposed candidate claim,
  separate from the currently approved field claim.

## What Should Eventually Move To Survey

These concepts are not Campfit-specific and are candidates for extraction after
the Survey boundary is proven in code:

- raw source identity: source URL, crawl/proposal id, observed time
- extraction observation: target field, value, confidence, excerpt, source URL
- resolution/proposal result: old value, new candidate, confidence, rationale
- review/promotion result: approved field source, rejected proposal, pending candidate
- Surface adapter mapping: claim/evidence/event construction

Campfit should keep:

- camp/provider domain model and admin workflows
- crawl target selection and scraping strategy
- field display labels and directory UX
- array-field semantics for schedules, pricing, and age groups

## Current Limitation

This proof intentionally starts with one scalar field. Array fields such as
schedules, pricing, and age groups need per-item provenance before they should
drive the Survey extraction boundary.
