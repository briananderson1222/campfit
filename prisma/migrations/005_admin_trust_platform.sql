-- Camp Fit Migration 005: admin trust platform primitives
-- Adds archive state, review flags, attestations, accreditations, people graph,
-- and AI action logging so UI and MCP-style tools can share one backend.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminEntityType') THEN
    CREATE TYPE "AdminEntityType" AS ENUM ('CAMP', 'PROVIDER', 'PERSON');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReviewFlagStatus') THEN
    CREATE TYPE "ReviewFlagStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttestationStatus') THEN
    CREATE TYPE "AttestationStatus" AS ENUM ('ACTIVE', 'STALE', 'INVALIDATED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AiActionCapability') THEN
    CREATE TYPE "AiActionCapability" AS ENUM ('READ', 'PROPOSE', 'WRITE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AiActionStatus') THEN
    CREATE TYPE "AiActionStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'REJECTED', 'COMPLETED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "Camp"
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "archivedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "archiveReason" TEXT,
  ADD COLUMN IF NOT EXISTS "applicationUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "contactEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "socialLinks" JSONB,
  ADD COLUMN IF NOT EXISTS "lastCrawledAt" TIMESTAMPTZ;

ALTER TABLE "Provider"
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "archivedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "archiveReason" TEXT,
  ADD COLUMN IF NOT EXISTS "applicationUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "socialLinks" JSONB,
  ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "ReviewFlag" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "entityType"  "AdminEntityType" NOT NULL,
  "entityId"    TEXT NOT NULL,
  comment       TEXT NOT NULL,
  status        "ReviewFlagStatus" NOT NULL DEFAULT 'OPEN',
  "createdBy"   TEXT NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolvedBy"  TEXT,
  "resolvedAt"  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "ReviewFlag_entity_idx" ON "ReviewFlag"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "ReviewFlag_status_idx" ON "ReviewFlag"(status);

CREATE TABLE IF NOT EXISTS "FieldAttestation" (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "entityType"        "AdminEntityType" NOT NULL,
  "entityId"          TEXT NOT NULL,
  "fieldKey"          TEXT NOT NULL,
  "valueSnapshot"     JSONB,
  excerpt             TEXT,
  "sourceUrl"         TEXT,
  "observedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "approvedAt"        TIMESTAMPTZ,
  "approvedBy"        TEXT,
  status              "AttestationStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastRecheckedAt"   TIMESTAMPTZ,
  "invalidatedAt"     TIMESTAMPTZ,
  "invalidationReason" TEXT,
  notes               TEXT,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "FieldAttestation_entity_idx" ON "FieldAttestation"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "FieldAttestation_field_idx" ON "FieldAttestation"("entityType", "entityId", "fieldKey");

CREATE TABLE IF NOT EXISTS "AccreditationBody" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  "websiteUrl"  TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "CampAccreditation" (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "campId"        TEXT NOT NULL REFERENCES "Camp"(id) ON DELETE CASCADE,
  "bodyId"        TEXT NOT NULL REFERENCES "AccreditationBody"(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  scope           TEXT,
  "sourceUrl"     TEXT,
  excerpt         TEXT,
  "observedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "approvedAt"    TIMESTAMPTZ,
  "approvedBy"    TEXT,
  "lastVerifiedAt" TIMESTAMPTZ,
  "expiresAt"     TIMESTAMPTZ,
  notes           TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "CampAccreditation_camp_idx" ON "CampAccreditation"("campId");

CREATE TABLE IF NOT EXISTS "Person" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "fullName"    TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  bio           TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "PersonContactMethod" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "personId"    TEXT NOT NULL REFERENCES "Person"(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  value         TEXT NOT NULL,
  label         TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "PersonContactMethod_person_idx" ON "PersonContactMethod"("personId");

CREATE TABLE IF NOT EXISTS "CampPersonRole" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "campId"      TEXT NOT NULL REFERENCES "Camp"(id) ON DELETE CASCADE,
  "personId"    TEXT NOT NULL REFERENCES "Person"(id) ON DELETE CASCADE,
  title         TEXT,
  "roleType"    TEXT NOT NULL DEFAULT 'CONTACT',
  notes         TEXT,
  "sourceUrl"   TEXT,
  excerpt       TEXT,
  "observedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "approvedAt"  TIMESTAMPTZ,
  "approvedBy"  TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "CampPersonRole_camp_idx" ON "CampPersonRole"("campId");
CREATE INDEX IF NOT EXISTS "CampPersonRole_person_idx" ON "CampPersonRole"("personId");

CREATE TABLE IF NOT EXISTS "ProviderPersonRole" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerId"  TEXT NOT NULL REFERENCES "Provider"(id) ON DELETE CASCADE,
  "personId"    TEXT NOT NULL REFERENCES "Person"(id) ON DELETE CASCADE,
  title         TEXT,
  "roleType"    TEXT NOT NULL DEFAULT 'CONTACT',
  notes         TEXT,
  "sourceUrl"   TEXT,
  excerpt       TEXT,
  "observedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "approvedAt"  TIMESTAMPTZ,
  "approvedBy"  TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ProviderPersonRole_provider_idx" ON "ProviderPersonRole"("providerId");
CREATE INDEX IF NOT EXISTS "ProviderPersonRole_person_idx" ON "ProviderPersonRole"("personId");

CREATE TABLE IF NOT EXISTS "AiActionLog" (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  capability      "AiActionCapability" NOT NULL,
  action          TEXT NOT NULL,
  "entityType"    "AdminEntityType",
  "entityId"      TEXT,
  status          "AiActionStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedBy"   TEXT NOT NULL,
  "confirmedBy"   TEXT,
  "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
  input           JSONB,
  output          JSONB,
  error           TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "AiActionLog_entity_idx" ON "AiActionLog"("entityType", "entityId");
