# Lookout recrawl cutover

Camp rows in PostgreSQL remain the canonical reviewed state. Lookout sources are built in memory; CampFit does not load Lookout's file registry.

## Source identity

- Known camps retain the historical raw `Camp.id` snapshot source ID.
- Listing pages retain `campfit-discovery:${url}`.

Changing either ID starts a new validator, snapshot, and observation lineage and is therefore prohibited.

## Routing and rollback

`LOOKOUT_RECRAWL=1` selects the Lookout CHECK path. Every other value selects the existing Traverse recrawl adapter. The value is captured when the crawl module initializes; changing the environment of a running process does not change its strategy. Until the owner accepts the complete parity corpus, the default remains off. Rollback is to start a new process with `LOOKOUT_RECRAWL=0`.

Lookout CHECK classifies every effective fetch. `unchanged-304` and `unchanged-hash` skip extraction and update only `lastCrawledAt`. They never update `lastVerifiedAt`. Rendered attempts do not receive HTTP validators.

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
