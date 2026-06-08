-- Persist Survey review event snapshots for CampFit proposal review.
-- Survey remains the owner of the event/resource shape; CampFit indexes the fields it needs.

CREATE TABLE IF NOT EXISTS "SurveyReviewEvent" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "proposalId" text NOT NULL REFERENCES "CampChangeProposal"(id) ON DELETE CASCADE,
  "sessionName" text NOT NULL,
  sequence integer NOT NULL,
  "eventName" text NOT NULL,
  "eventType" text NOT NULL,
  "reviewItemName" text,
  "activeItemName" text,
  "reviewDecisionName" text,
  "candidateId" text,
  status text,
  rationale text,
  actor text,
  "occurredAt" timestamptz NOT NULL,
  event jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("proposalId", "sessionName", sequence)
);

CREATE INDEX IF NOT EXISTS "SurveyReviewEvent_proposal_idx"
  ON "SurveyReviewEvent" ("proposalId", "sessionName", sequence);

CREATE INDEX IF NOT EXISTS "SurveyReviewEvent_item_idx"
  ON "SurveyReviewEvent" ("proposalId", "reviewItemName");

