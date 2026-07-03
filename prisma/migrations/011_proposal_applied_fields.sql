-- Track schema drift: lib/admin/review-repository.ts's partialApprove
-- (pre-existing code, unaffected by this migration) reads and writes
-- "CampChangeProposal"."appliedFields"/"priority", but no tracked migration
-- has ever created them — see docs/review-apply-module.md's Accepted gaps
-- section for the full history of this finding.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op against a database where
-- these columns already exist out-of-band (e.g. the real Supabase instance,
-- if the drift theory is correct there too). Safe to apply to production.
--
-- Defaults match what lib/admin/review-repository.ts's partialApprove
-- assumes: "appliedFields" is read via `COALESCE("appliedFields", '{}')`
-- (tolerant of NULL) but is written back as a NOT NULL array once populated;
-- "priority" is read via `ORDER BY p.priority DESC` in getPendingProposals
-- and set to -1 by partialApprove, so existing PENDING rows must default to
-- a normal (non-deprioritized) value.
ALTER TABLE "CampChangeProposal"
  ADD COLUMN IF NOT EXISTS "appliedFields" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0;
