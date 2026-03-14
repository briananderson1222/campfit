CREATE TABLE IF NOT EXISTS "CampChangeLog" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "campId" text NOT NULL REFERENCES "Camp"(id) ON DELETE CASCADE,
  "proposalId" text,
  "changedAt" timestamptz NOT NULL DEFAULT now(),
  "changedBy" text NOT NULL,
  "fieldName" text NOT NULL,
  "oldValue" text,
  "newValue" text,
  "changeType" text NOT NULL DEFAULT 'UPDATE'
);

CREATE INDEX IF NOT EXISTS "CampChangeLog_campId_idx"
  ON "CampChangeLog" ("campId");

CREATE INDEX IF NOT EXISTS "CampChangeLog_campId_fieldName_idx"
  ON "CampChangeLog" ("campId", "fieldName");

CREATE TABLE IF NOT EXISTS "ProviderChangeLog" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerId" text NOT NULL REFERENCES "Provider"(id) ON DELETE CASCADE,
  "changedAt" timestamptz NOT NULL DEFAULT now(),
  "changedBy" text NOT NULL,
  "fieldName" text NOT NULL,
  "oldValue" text,
  "newValue" text,
  "changeType" text NOT NULL DEFAULT 'UPDATE'
);

CREATE INDEX IF NOT EXISTS "ProviderChangeLog_providerId_idx"
  ON "ProviderChangeLog" ("providerId");

CREATE INDEX IF NOT EXISTS "ProviderChangeLog_providerId_fieldName_idx"
  ON "ProviderChangeLog" ("providerId", "fieldName");

CREATE TABLE IF NOT EXISTS "PersonChangeLog" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "personId" text NOT NULL REFERENCES "Person"(id) ON DELETE CASCADE,
  "changedAt" timestamptz NOT NULL DEFAULT now(),
  "changedBy" text NOT NULL,
  "fieldName" text NOT NULL,
  "oldValue" text,
  "newValue" text,
  "changeType" text NOT NULL DEFAULT 'UPDATE'
);

CREATE INDEX IF NOT EXISTS "PersonChangeLog_personId_idx"
  ON "PersonChangeLog" ("personId");

CREATE INDEX IF NOT EXISTS "PersonChangeLog_personId_fieldName_idx"
  ON "PersonChangeLog" ("personId", "fieldName");
