-- CampScout Migration 003: User-submitted camp reports

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportType') THEN
    CREATE TYPE "ReportType" AS ENUM ('WRONG_INFO', 'MISSING_INFO', 'CAMP_CLOSED', 'OTHER');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CampReport" (
  id            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "campId"      TEXT NOT NULL REFERENCES "Camp"(id) ON DELETE CASCADE,
  "userId"      TEXT,
  "userEmail"   TEXT,
  type          "ReportType" NOT NULL DEFAULT 'OTHER',
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | REVIEWED | DISMISSED
  "adminNotes"  TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "CampReport_pkey" PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS "CampReport_campId_idx" ON "CampReport"("campId");
CREATE INDEX IF NOT EXISTS "CampReport_status_idx" ON "CampReport"(status);

-- Add registrationCloseDate to Camp
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "registrationCloseDate" DATE;
