-- Admin pipeline schema
-- Run against Supabase: psql $DATABASE_URL -f scripts/sql/admin-schema.sql

DO $$ BEGIN
  CREATE TYPE "CrawlStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "CrawlTrigger" AS ENUM ('MANUAL', 'SCHEDULED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ChangeType" AS ENUM ('UPDATE', 'NEW_CAMP', 'FIELD_POPULATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CrawlRun" (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "startedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"    TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'RUNNING',
  "totalCamps"     INT NOT NULL DEFAULT 0,
  "processedCamps" INT NOT NULL DEFAULT 0,
  "errorCount"     INT NOT NULL DEFAULT 0,
  "newProposals"   INT NOT NULL DEFAULT 0,
  trigger          TEXT NOT NULL DEFAULT 'MANUAL',
  "triggeredBy"    TEXT,
  "campIds"        TEXT[],
  "errorLog"       JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "CrawlRun_startedAt_idx" ON "CrawlRun" ("startedAt" DESC);
CREATE INDEX IF NOT EXISTS "CrawlRun_status_idx" ON "CrawlRun" (status);

CREATE TABLE IF NOT EXISTS "CampChangeProposal" (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "campId"            TEXT NOT NULL REFERENCES "Camp"(id) ON DELETE CASCADE,
  "crawlRunId"        TEXT REFERENCES "CrawlRun"(id) ON DELETE SET NULL,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reviewedAt"        TIMESTAMPTZ,
  "reviewedBy"        TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  "sourceUrl"         TEXT NOT NULL,
  "rawExtraction"     JSONB NOT NULL DEFAULT '{}'::jsonb,
  "proposedChanges"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "overallConfidence" FLOAT NOT NULL DEFAULT 0,
  "extractionModel"   TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
  "reviewerNotes"     TEXT,
  "feedbackTags"      TEXT[]
);

CREATE INDEX IF NOT EXISTS "CampChangeProposal_campId_idx" ON "CampChangeProposal" ("campId");
CREATE INDEX IF NOT EXISTS "CampChangeProposal_status_idx" ON "CampChangeProposal" (status);
CREATE INDEX IF NOT EXISTS "CampChangeProposal_crawlRunId_idx" ON "CampChangeProposal" ("crawlRunId");
CREATE INDEX IF NOT EXISTS "CampChangeProposal_createdAt_idx" ON "CampChangeProposal" ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS "CampChangeLog" (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "campId"     TEXT NOT NULL REFERENCES "Camp"(id) ON DELETE CASCADE,
  "proposalId" TEXT REFERENCES "CampChangeProposal"(id) ON DELETE SET NULL,
  "changedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "changedBy"  TEXT NOT NULL,
  "fieldName"  TEXT NOT NULL,
  "oldValue"   TEXT,
  "newValue"   TEXT,
  "changeType" TEXT NOT NULL DEFAULT 'UPDATE'
);

CREATE INDEX IF NOT EXISTS "CampChangeLog_campId_idx" ON "CampChangeLog" ("campId");
CREATE INDEX IF NOT EXISTS "CampChangeLog_changedAt_idx" ON "CampChangeLog" ("changedAt" DESC);

CREATE TABLE IF NOT EXISTS "CrawlMetric" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "recordedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "crawlRunId"  TEXT REFERENCES "CrawlRun"(id) ON DELETE SET NULL,
  "metricName"  TEXT NOT NULL,
  "metricValue" FLOAT NOT NULL,
  dimensions    JSONB
);

CREATE INDEX IF NOT EXISTS "CrawlMetric_metricName_idx" ON "CrawlMetric" ("metricName", "recordedAt" DESC);
CREATE INDEX IF NOT EXISTS "CrawlMetric_crawlRunId_idx" ON "CrawlMetric" ("crawlRunId");
