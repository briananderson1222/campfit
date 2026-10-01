-- 022_camp_crawl_attempt_and_content_digest.sql — crawl scheduling state.
--
-- "lastCrawlAttemptAt": when a crawl last TRIED this camp, whatever the
-- outcome. The scheduler orders by it, so a camp that keeps failing (a dead
-- URL) rotates to the back instead of being reselected on every run.
-- "lastCrawledAt" (migration 005) keeps its meaning: the last crawl that
-- completed. Neither is a verification time; "lastVerifiedAt" is written only
-- by the verification authority after a human review.
--
-- "lastExtractedContentDigest": fingerprint of the prepared page text the last
-- COMPLETE extraction read (lib/ingestion/content-fingerprint.ts). A re-crawl
-- that fetches the same text skips the model call. NULL means no complete
-- extraction has been recorded, so the next crawl always extracts.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS), no backfill: every camp
-- starts NULL, which is the "never attempted / never extracted" state.

ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "lastCrawlAttemptAt" TIMESTAMPTZ;
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "lastExtractedContentDigest" TEXT;
