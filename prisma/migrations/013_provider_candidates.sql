-- 013_provider_candidates.sql — provider-discovery review queue (I22 / #52).
--
-- ADDITIVE ONLY. Creates one new self-contained table, "ProviderCandidate", and
-- its indexes. It references no existing model (an approved candidate stores the
-- id of the Provider it created, but there is NO foreign key), so it touches
-- nothing in the claim store / verification / admin-review surface and can be
-- applied in any order relative to the concurrent claim-store migration (012)
-- on feat/verification-authority.
--
-- MERGE-ORDERING NOTE: this file is NOT yet wired into
-- scripts/test-db-reset.ts's SCHEMA_FILES array (that file is being modified on
-- feat/verification-authority; this branch left it untouched to avoid a
-- conflict). After merge, append this path to SCHEMA_FILES, ordered after 012.
-- The discovery CLI and the integration test provision this table at runtime via
-- ensureProviderCandidateSchema() (identical idempotent DDL), so nothing depends
-- on the migration being wired in first.

CREATE TABLE IF NOT EXISTS "ProviderCandidate" (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                   TEXT NOT NULL,
  "normalizedName"       TEXT NOT NULL,
  "websiteUrl"           TEXT,
  domain                 TEXT,
  city                   TEXT,
  neighborhood           TEXT,
  "communitySlug"        TEXT NOT NULL DEFAULT 'denver',
  status                 TEXT NOT NULL DEFAULT 'PENDING',
  "possibleDuplicateOfProviderId" TEXT,
  "possibleDuplicateOfName"       TEXT,
  "duplicateReason"      TEXT,
  "sourceKey"            TEXT NOT NULL,
  "sourceLabel"          TEXT NOT NULL,
  "discoveryQuery"       TEXT,
  "retrievedAt"          TIMESTAMPTZ NOT NULL,
  "approvedProviderId"   TEXT,
  "reviewedAt"           TIMESTAMPTZ,
  "reviewedBy"           TEXT,
  "reviewerNotes"        TEXT,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ProviderCandidate_status_idx" ON "ProviderCandidate"(status);
CREATE INDEX IF NOT EXISTS "ProviderCandidate_domain_idx" ON "ProviderCandidate"(domain);
CREATE INDEX IF NOT EXISTS "ProviderCandidate_normalizedName_idx" ON "ProviderCandidate"("normalizedName");
CREATE INDEX IF NOT EXISTS "ProviderCandidate_community_idx" ON "ProviderCandidate"("communitySlug", status);
