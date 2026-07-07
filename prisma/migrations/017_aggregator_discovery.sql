-- 017_aggregator_discovery.sql — aggregator-source registration + ToS-decision
-- gate, and the additive ProviderCandidate provenance extension it feeds
-- (campfit#93).
--
-- ADDITIVE ONLY. Creates one new self-contained table, "AggregatorSource" (no
-- FK — mirrors 013_provider_candidates.sql's own no-FK discipline), and
-- extends "ProviderCandidate" with nullable columns via ADD COLUMN IF NOT
-- EXISTS (matches 015_proposal_snapshot_ref.sql's nullable-column-forward
-- precedent). Every existing ProviderCandidate row (e.g. from the pre-existing
-- curated-source discovery lane, I22/#52) is simply NULL on the new columns
-- until the aggregator discovery orchestration starts populating them.
--
-- MERGE-ORDERING NOTE: this file is deliberately NOT wired into
-- scripts/test-db-reset.ts's SCHEMA_FILES array, following the SAME
-- intentional non-wiring precedent 013_provider_candidates.sql already set
-- (tracked under campfit#98, "derive SCHEMA_FILES from the migrations dir").
-- Since 013 itself is never run via SCHEMA_FILES in a fresh test-db reset, a
-- migration that ALTERs it could not be safely wired into that list anyway
-- without first fixing #98. Schema provisioning for tests/CLI instead goes
-- through this module's own idempotent DDL:
-- `ensureAggregatorSourceSchema()`/`AGGREGATOR_SOURCE_SCHEMA_SQL`
-- (lib/ingestion/aggregator/aggregator-repository.ts) for the new table, and
-- `ensureProviderCandidateSchema()`'s updated `PROVIDER_CANDIDATE_SCHEMA_SQL`
-- (lib/ingestion/discovery/candidate-repository.ts) for the new columns —
-- both called at the top of the aggregator orchestration/routes and in test
-- `beforeAll`, exactly like the existing discovery lane's tests already do.

CREATE TABLE IF NOT EXISTS "AggregatorSource" (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  "communitySlug"  TEXT NOT NULL DEFAULT 'denver',
  "maxPages"       INTEGER NOT NULL DEFAULT 20,
  "maxDepth"       INTEGER NOT NULL DEFAULT 2,
  status           TEXT NOT NULL DEFAULT 'REGISTERED',
  "tosDecision"    TEXT,
  "tosReviewedBy"  TEXT,
  "tosReviewedAt"  TIMESTAMPTZ,
  "tosNotes"       TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "AggregatorSource_status_idx" ON "AggregatorSource"(status);
CREATE INDEX IF NOT EXISTS "AggregatorSource_community_idx" ON "AggregatorSource"("communitySlug");

ALTER TABLE "ProviderCandidate"
  ADD COLUMN IF NOT EXISTS "locale" TEXT,
  ADD COLUMN IF NOT EXISTS "aggregatorSourceId" TEXT,
  ADD COLUMN IF NOT EXISTS "provenanceExcerpt" TEXT,
  ADD COLUMN IF NOT EXISTS "provenanceLocator" TEXT,
  ADD COLUMN IF NOT EXISTS "snapshotSourceRef" TEXT;

CREATE INDEX IF NOT EXISTS "ProviderCandidate_aggregatorSourceId_idx" ON "ProviderCandidate"("aggregatorSourceId");
