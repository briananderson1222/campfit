-- Persist the server-created Survey review snapshot that browser events and apply
-- requests must bind to. The browser may submit review events, but it must not be
-- the authority for the ReviewItem snapshot being applied.

CREATE TABLE IF NOT EXISTS "SurveyReviewSession" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "proposalId" text NOT NULL REFERENCES "CampChangeProposal"(id) ON DELETE CASCADE,
  "sessionName" text NOT NULL,
  snapshot jsonb NOT NULL,
  "snapshotHash" text NOT NULL,
  "proposalStatus" text NOT NULL,
  "createdBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "appliedAt" timestamptz,
  UNIQUE ("proposalId", "sessionName")
);

CREATE INDEX IF NOT EXISTS "SurveyReviewSession_proposal_idx"
  ON "SurveyReviewSession" ("proposalId", "sessionName");

ALTER TABLE "SurveyReviewEvent"
  ADD COLUMN IF NOT EXISTS "reviewSessionId" text REFERENCES "SurveyReviewSession"(id) ON DELETE CASCADE;

ALTER TABLE "SurveyReviewEvent"
  DROP CONSTRAINT IF EXISTS "SurveyReviewEvent_proposalId_sessionName_sequence_key";

CREATE UNIQUE INDEX IF NOT EXISTS "SurveyReviewEvent_session_sequence_uniq"
  ON "SurveyReviewEvent" ("reviewSessionId", "sessionName", sequence)
  WHERE "reviewSessionId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "SurveyReviewEvent_legacy_proposal_sequence_uniq"
  ON "SurveyReviewEvent" ("proposalId", "sessionName", sequence)
  WHERE "reviewSessionId" IS NULL;

CREATE INDEX IF NOT EXISTS "SurveyReviewEvent_session_idx"
  ON "SurveyReviewEvent" ("reviewSessionId", "sessionName", sequence);
