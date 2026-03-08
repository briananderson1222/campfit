-- CampScout Initial Schema
-- Generated from prisma/schema.prisma

-- ─── Enums ───────────────────────────────────────────────────

CREATE TYPE "CampType" AS ENUM (
  'SUMMER_DAY', 'SLEEPAWAY', 'FAMILY', 'VIRTUAL', 'WINTER_BREAK', 'SCHOOL_BREAK'
);

CREATE TYPE "CampCategory" AS ENUM (
  'SPORTS', 'ARTS', 'STEM', 'NATURE', 'ACADEMIC', 'MUSIC',
  'THEATER', 'COOKING', 'MULTI_ACTIVITY', 'OTHER'
);

CREATE TYPE "RegistrationStatus" AS ENUM (
  'OPEN', 'CLOSED', 'WAITLIST', 'COMING_SOON', 'UNKNOWN'
);

CREATE TYPE "DataConfidence" AS ENUM ('VERIFIED', 'PLACEHOLDER', 'STALE');

CREATE TYPE "SourceType" AS ENUM ('CSV', 'SCRAPER', 'MANUAL', 'PROVIDER_FORM');

CREATE TYPE "PricingUnit" AS ENUM (
  'PER_WEEK', 'PER_SESSION', 'PER_DAY', 'FLAT', 'PER_CAMP'
);

CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'GOOGLE');

CREATE TYPE "UserTier" AS ENUM ('FREE', 'PREMIUM');

CREATE TYPE "NotificationType" AS ENUM (
  'REGISTRATION_OPENS', 'CAMP_APPROACHING', 'NEW_CAMP_MATCH'
);

CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'PUSH', 'SMS');

CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TYPE "DataSourceStatus" AS ENUM ('SUCCESS', 'FAILED', 'PARTIAL');

-- ─── Camp ────────────────────────────────────────────────────

CREATE TABLE "Camp" (
  "id"                   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "slug"                 TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "description"          TEXT NOT NULL DEFAULT '',
  "notes"                TEXT,
  "campType"             "CampType" NOT NULL,
  "category"             "CampCategory" NOT NULL,
  "websiteUrl"           TEXT NOT NULL DEFAULT '',
  "interestingDetails"   TEXT,

  "city"                 TEXT NOT NULL DEFAULT 'Denver',
  "region"               TEXT,
  "neighborhood"         TEXT NOT NULL DEFAULT '',
  "address"              TEXT NOT NULL DEFAULT '',
  "latitude"             DOUBLE PRECISION,
  "longitude"            DOUBLE PRECISION,

  "lunchIncluded"        BOOLEAN NOT NULL DEFAULT false,

  "registrationOpenDate" DATE,
  "registrationOpenTime" TEXT,
  "registrationStatus"   "RegistrationStatus" NOT NULL DEFAULT 'UNKNOWN',

  "sourceType"           "SourceType" NOT NULL DEFAULT 'CSV',
  "sourceUrl"            TEXT,
  "lastVerifiedAt"       TIMESTAMP(3),
  "dataConfidence"       "DataConfidence" NOT NULL DEFAULT 'PLACEHOLDER',

  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Camp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Camp_slug_key" ON "Camp"("slug");
CREATE INDEX "Camp_category_idx" ON "Camp"("category");
CREATE INDEX "Camp_campType_idx" ON "Camp"("campType");
CREATE INDEX "Camp_neighborhood_idx" ON "Camp"("neighborhood");
CREATE INDEX "Camp_registrationStatus_idx" ON "Camp"("registrationStatus");
CREATE INDEX "Camp_city_idx" ON "Camp"("city");

-- ─── CampAgeGroup ─────────────────────────────────────────────

CREATE TABLE "CampAgeGroup" (
  "id"       TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "campId"   TEXT NOT NULL,
  "label"    TEXT NOT NULL,
  "minAge"   INTEGER,
  "maxAge"   INTEGER,
  "minGrade" INTEGER,
  "maxGrade" INTEGER,

  CONSTRAINT "CampAgeGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampAgeGroup_campId_fkey"
    FOREIGN KEY ("campId") REFERENCES "Camp"("id") ON DELETE CASCADE
);

CREATE INDEX "CampAgeGroup_campId_idx" ON "CampAgeGroup"("campId");
CREATE INDEX "CampAgeGroup_minAge_maxAge_idx" ON "CampAgeGroup"("minAge", "maxAge");

-- ─── CampSchedule ─────────────────────────────────────────────

CREATE TABLE "CampSchedule" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "campId"       TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "startDate"    DATE NOT NULL,
  "endDate"      DATE NOT NULL,
  "startTime"    TEXT,
  "endTime"      TEXT,
  "earlyDropOff" TEXT,
  "latePickup"   TEXT,

  CONSTRAINT "CampSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampSchedule_campId_fkey"
    FOREIGN KEY ("campId") REFERENCES "Camp"("id") ON DELETE CASCADE
);

CREATE INDEX "CampSchedule_campId_idx" ON "CampSchedule"("campId");
CREATE INDEX "CampSchedule_startDate_idx" ON "CampSchedule"("startDate");
CREATE INDEX "CampSchedule_startDate_endDate_idx" ON "CampSchedule"("startDate", "endDate");

-- ─── CampPricing ──────────────────────────────────────────────

CREATE TABLE "CampPricing" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "campId"        TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "amount"        DECIMAL(10,2) NOT NULL,
  "unit"          "PricingUnit" NOT NULL,
  "durationWeeks" INTEGER,
  "ageQualifier"  TEXT,
  "discountNotes" TEXT,

  CONSTRAINT "CampPricing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampPricing_campId_fkey"
    FOREIGN KEY ("campId") REFERENCES "Camp"("id") ON DELETE CASCADE
);

CREATE INDEX "CampPricing_campId_idx" ON "CampPricing"("campId");

-- ─── User ─────────────────────────────────────────────────────

CREATE TABLE "User" (
  "id"                     TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "email"                  TEXT NOT NULL,
  "name"                   TEXT NOT NULL DEFAULT '',
  "authProvider"           "AuthProvider" NOT NULL DEFAULT 'EMAIL',
  "tier"                   "UserTier" NOT NULL DEFAULT 'FREE',
  "stripeCustomerId"       TEXT,
  "stripeSubscriptionId"   TEXT,

  "notifyEmail"            BOOLEAN NOT NULL DEFAULT true,
  "notifyPush"             BOOLEAN NOT NULL DEFAULT false,
  "notifySms"              BOOLEAN NOT NULL DEFAULT false,
  "phoneNumber"            TEXT,

  "childAgeMin"            INTEGER,
  "childAgeMax"            INTEGER,
  "preferredNeighborhoods" TEXT[] NOT NULL DEFAULT '{}',
  "preferredCategories"    "CampCategory"[] NOT NULL DEFAULT '{}',

  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- ─── SavedCamp ────────────────────────────────────────────────

CREATE TABLE "SavedCamp" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"      TEXT NOT NULL,
  "campId"      TEXT NOT NULL,
  "notes"       TEXT,
  "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
  "notifyPush"  BOOLEAN NOT NULL DEFAULT false,
  "notifySms"   BOOLEAN NOT NULL DEFAULT false,
  "savedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SavedCamp_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SavedCamp_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "SavedCamp_campId_fkey"
    FOREIGN KEY ("campId") REFERENCES "Camp"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "SavedCamp_userId_campId_key" ON "SavedCamp"("userId", "campId");
CREATE INDEX "SavedCamp_userId_idx" ON "SavedCamp"("userId");
CREATE INDEX "SavedCamp_campId_idx" ON "SavedCamp"("campId");

-- ─── Notification ─────────────────────────────────────────────

CREATE TABLE "Notification" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"       TEXT NOT NULL,
  "campId"       TEXT,
  "type"         "NotificationType" NOT NULL,
  "channel"      "NotificationChannel" NOT NULL,
  "title"        TEXT NOT NULL,
  "body"         TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "sentAt"       TIMESTAMP(3),
  "status"       "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "Notification_campId_fkey"
    FOREIGN KEY ("campId") REFERENCES "Camp"("id") ON DELETE SET NULL
);

CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");
CREATE INDEX "Notification_status_scheduledFor_idx" ON "Notification"("status", "scheduledFor");
CREATE INDEX "Notification_campId_idx" ON "Notification"("campId");

-- ─── PushSubscription ─────────────────────────────────────────

CREATE TABLE "PushSubscription" (
  "id"        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId"    TEXT NOT NULL,
  "endpoint"  TEXT NOT NULL,
  "p256dh"    TEXT NOT NULL,
  "auth"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PushSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- ─── DataSource ───────────────────────────────────────────────

CREATE TABLE "DataSource" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"         TEXT NOT NULL,
  "type"         "SourceType" NOT NULL,
  "targetUrl"    TEXT NOT NULL DEFAULT '',
  "schedule"     TEXT,
  "parserConfig" JSONB,
  "lastRunAt"    TIMESTAMP(3),
  "lastStatus"   "DataSourceStatus",
  "campCount"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- ─── DataSourceCamp ───────────────────────────────────────────

CREATE TABLE "DataSourceCamp" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "dataSourceId" TEXT NOT NULL,
  "campId"       TEXT NOT NULL,
  "externalId"   TEXT,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DataSourceCamp_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataSourceCamp_dataSourceId_fkey"
    FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE,
  CONSTRAINT "DataSourceCamp_campId_fkey"
    FOREIGN KEY ("campId") REFERENCES "Camp"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "DataSourceCamp_dataSourceId_campId_key"
  ON "DataSourceCamp"("dataSourceId", "campId");
CREATE INDEX "DataSourceCamp_dataSourceId_idx" ON "DataSourceCamp"("dataSourceId");
CREATE INDEX "DataSourceCamp_campId_idx" ON "DataSourceCamp"("campId");

-- ─── Auto-update updatedAt ────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Camp_updatedAt"
  BEFORE UPDATE ON "Camp"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER "User_updatedAt"
  BEFORE UPDATE ON "User"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER "DataSource_updatedAt"
  BEFORE UPDATE ON "DataSource"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
