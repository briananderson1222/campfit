# Lookout recrawl cutover

Camp rows in PostgreSQL remain the canonical reviewed state. Lookout sources are built in memory; CampFit does not load Lookout's file registry.

## Source identity

Lookout keeps its captures in CampFit's snapshot store, wrapped with Lookout's `fromTraverseSnapshotStore` (Lookout 0.8.8), under source IDs that no Traverse fetch writes:

- Known camps: `lookout:${Camp.id}`. The legacy Traverse recrawl writes under the raw `Camp.id`.
- Listing pages: `lookout:campfit-discovery:${url}`. Traverse's live discovery writes under `campfit-discovery:${url}`.
- Drift-gated provider sources: `lookout:${key}`. The sources-strategy extraction writes under `key`.

Lookout compares each fetch with the latest capture under its source ID. Under a shared ID a Traverse capture becomes that prior: a capture Traverse hashed over decoded text makes every later CHECK `changed`, a Traverse capture carries no validators so no `304` is ever answered, and a Traverse capture of new content between two CHECKs would let the second report unchanged against content no observation was made of. The Lookout coordinators replay their own capture by passing the Lookout source ID as a replay-only `replaySourceId`; a live Traverse fetch that names one is refused.

These IDs started a new Lookout lineage (they replaced the raw `Camp.id` and `campfit-discovery:${url}` IDs Lookout used before). Captures and observations recorded under the old IDs stay in place and still read; review, apply and attestation resolve snapshot references by the source ID inside the reference. The first CHECK of each source under the new ID records a new baseline. A pending Survey delivery staged under an old ID is not reconciled under the new one. Changing these IDs again starts another lineage.

An unchanged CHECK (`304` or hash) skips extraction only when its capture has the source, URL and body hash of the latest committed observation. Otherwise (a replay or emission failed after a changed CHECK stored its capture, or the store holds a capture no observation was made of) the coordinator replays it and emits the difference.

## Routing and rollback

`LOOKOUT_RECRAWL=1` selects the Lookout CHECK path. Every other value selects the existing Traverse recrawl adapter. The value is captured when the crawl module initializes; changing the environment of a running process does not change its strategy. Until the owner accepts the complete parity corpus, the default remains off. Rollback is to start a new process with `LOOKOUT_RECRAWL=0`.

Lookout CHECK classifies every effective fetch. `unchanged-304` and `unchanged-hash` of the observed content skip extraction and update only `lastCrawledAt`. They never update `lastVerifiedAt`. Rendered attempts do not receive HTTP validators.

## Events, DB-current review semantics, and baseline

Lookout 0.2.0 obtains the prior proposal observation from its observation store; its emitter does not accept a caller-supplied prior observation. Lookout observations/events therefore own source continuity, freshness, survey emission, and listing discovery. Known-camp reviewer changes are projected through CampFit's D1 DB-current kernel route (`diff-engine` -> `lookout-diff-adapter`) after a changed CHECK. These review projections are not relabeled as event-derived.

Before event delivery is enabled for an existing source, the current snapshot corpus seeds its observation baseline with zero Lookout events. When replay computes DB-current reviewer proposals, the coordinator marks the result for one unchanged-freshness write without marking it freshness-only; the production crawl dispatcher then creates the normal review proposal exactly once. Zero-event baseline never means zero review proposals. Later changed checks emit normally. This prevents first enablement from mass-emitting existing observations without suppressing a pending snapshot-vs-database change.

`eventsToProposedChanges` is guarded as the event mapper contract by the parity report's drift check. For the same extraction, it compares every mapped field and mode against the D1 DB-current projection. The reviewer projection intentionally remains D1-owned; this guard makes event filtering and field identity drift fail parity rather than pretending the two orchestration columns use independent review kernels.

Prior-only removals are surfaced as warnings/parity facts. They are never converted into destructive review proposals.

## Observation and survey storage

Proposal observations live under `.kontourai/campfit/lookout-observations/`. Survey batches are atomically spooled under `.kontourai/campfit/survey/`, keyed by source and snapshot so retries are idempotent. Files contain proposed, observation-only claims with `campfit.camp` subject mapping and snapshot evidence.

The spool is a durable handoff boundary. Its consumer is the CampFit survey integration job, which validates and imports a batch before deleting it. Operators retain unconsumed or failed batches for audit/retry; successful batches may be removed only after the consumer records acceptance. The application does not age-delete spool entries.

Pending spool reconciliation runs at known-camp coordinator entry, before CHECK and before any unchanged early return. A pointer-advanced/finalize-failed batch is therefore published even if every later source response is `304` or hash-unchanged.

## Acceptance and retirement

The deterministic report is generated with `npm run report:l4-lookout-parity -- --output .kontourai/flow-agents/l4-cutover/parity-report.md`. The flag-off implementation remains until the owner accepts the complete local snapshot/DB corpus report. Default-on and legacy deletion are separate, owner-approved steps.
