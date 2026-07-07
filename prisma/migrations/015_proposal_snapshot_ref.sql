-- Migration number coordination (recorded per orchestrator instruction, not
-- part of the plan's own text): at the time this file was authored, the
-- latest migration visible in this worktree was 013_provider_candidates.sql.
-- A parallel lane (feat/85-orchestrator-convergence, a separate worktree) is
-- concurrently claiming the immediate next number (014) for its own additive
-- migration. To avoid a filename/number collision when both branches merge,
-- this migration was deliberately numbered 015 (one past 014) rather than
-- 014. Both migrations are independent additive-column changes with no
-- shared table/column overlap, so relative apply order between 014 and 015
-- is irrelevant to correctness.
--
-- Adds the (nullable, additive) snapshotRef/snapshotBodyHash columns needed
-- to trace a CampChangeProposal back to the exact traverse-fetch snapshot it
-- was extracted from (see @kontourai/traverse/fetch's buildSnapshotSourceRef/
-- parseSnapshotSourceRef + lib/ingestion/traverse-snapshot-store.ts's
-- createCampfitSnapshotStore()). Every existing/current row is simply NULL
-- until a follow-up ingestion-lane change (explicitly out of scope for this
-- slice — see campfit#91 review-provenance-validation plan, R2 Stop-short
-- risks) starts populating these columns on newly-created proposals.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op if these columns already
-- exist out-of-band, mirroring 011_proposal_applied_fields.sql's precedent.
ALTER TABLE "CampChangeProposal"
  ADD COLUMN IF NOT EXISTS "snapshotRef" TEXT,
  ADD COLUMN IF NOT EXISTS "snapshotBodyHash" TEXT;
