-- CampScout Migration 002: Provider entity + fieldSources + FULL registration status
-- Run with: psql "$DATABASE_URL" -f prisma/migrations/002_provider_and_field_sources.sql

-- ─── 1. Add FULL to RegistrationStatus enum ───────────────────────────────────
-- PostgreSQL can only add enum values (not rename/remove without table rebuilds)
ALTER TYPE "RegistrationStatus" ADD VALUE IF NOT EXISTS 'FULL' AFTER 'OPEN';

-- ─── 2. Add fieldSources JSONB to Camp ────────────────────────────────────────
-- Shape: { [fieldName]: { excerpt: string|null, sourceUrl: string, approvedAt: ISO } }
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "fieldSources" JSONB;

-- ─── 3. Add organizationName to Camp (lightweight org correlation, Phase 1) ───
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "organizationName" TEXT;

-- ─── 4. Create Provider table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Provider" (
  id              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  "websiteUrl"    TEXT,
  domain          TEXT,            -- derived from websiteUrl, indexed for CrawlSiteHint join
  "logoUrl"       TEXT,
  address         TEXT,
  city            TEXT,
  neighborhood    TEXT,
  "contactEmail"  TEXT,
  "contactPhone"  TEXT,
  notes           TEXT,            -- admin-only internal notes
  "crawlRootUrl"  TEXT,            -- discovery crawl entry point (may differ from websiteUrl)
  "communitySlug" TEXT NOT NULL DEFAULT 'denver',
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "Provider_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS "Provider_slug_key" ON "Provider"(slug);
CREATE INDEX IF NOT EXISTS "Provider_domain_idx" ON "Provider"(domain);
CREATE INDEX IF NOT EXISTS "Provider_communitySlug_idx" ON "Provider"("communitySlug");

-- ─── 5. Add providerId FK to Camp ─────────────────────────────────────────────
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "providerId" TEXT
  REFERENCES "Provider"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "Camp_providerId_idx" ON "Camp"("providerId");

-- ─── 6. Add communitySlug to Camp (if missing from initial schema) ────────────
-- (Already in initial schema but adding IF NOT EXISTS for safety)
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "communitySlug" TEXT NOT NULL DEFAULT 'denver';
