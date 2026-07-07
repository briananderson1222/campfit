-- 018_review_batch_accept_audit.sql — audit trail for the confidence-ranked
-- review queue's batch-accept action (campfit#51, R3/AC3).
--
-- ADDITIVE ONLY. Creates one brand-new, self-contained table with NO `ALTER`
-- on any other (wired or unwired) table — deliberately, unlike
-- 013_provider_candidates.sql/017_aggregator_discovery.sql (tracked under
-- campfit#98, "derive SCHEMA_FILES from the migrations dir"), which are NOT
-- wired into scripts/test-db-reset.ts's SCHEMA_FILES because 017 ALTERs the
-- unwired 013. This migration is therefore SAFE to wire into SCHEMA_FILES
-- directly (see that file's own edit, same task) — it adds no new #98 drift,
-- since resetTestDatabase() never needs to create/ALTER a table this
-- migration doesn't itself fully own.
--
-- No foreign keys: `claims`/`excluded` (jsonb) carry `proposalId`/`campId` as
-- plain text references, not FKs — mirrors 013/017's own no-FK discipline —
-- so a later Proposal/Camp deletion never blocks reading an old audit row.
--
-- `criteria` is a free-text label for the rule version that produced this
-- batch (e.g. 'exact-corroboration-v1') — a plain TEXT, not an enum, matching
-- "CrawlRun".trigger/status's existing convention of letting the TS-side
-- union type be the real constraint, not the schema.

CREATE TABLE IF NOT EXISTS "ReviewBatchAcceptAudit" (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "performedBy"    TEXT NOT NULL,
  "performedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  criteria         TEXT NOT NULL,
  "requestedCount" INTEGER NOT NULL,
  "appliedCount"   INTEGER NOT NULL,
  claims           JSONB NOT NULL,
  excluded         JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "ReviewBatchAcceptAudit_performedAt_idx" ON "ReviewBatchAcceptAudit" ("performedAt");
