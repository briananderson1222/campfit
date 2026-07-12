-- 020_community_neighborhood_and_crawl_site_hint.sql — capture two tables that
-- existed in PRODUCTION but in NO migration file or schema.prisma (untracked
-- legacy DDL). Surfaced 2026-07-12 by the first faithful "rebuild from the repo"
-- (the new local Postgres env, docker-compose.postgres.yml): a repo-built
-- database had neither table, yet `lib/ingestion/crawl-pipeline.ts` hard-depends
-- on "CommunityNeighborhood" (a real crawl fails with 42P01 without it). This is
-- the same class of gap as campfit#98 ("derive SCHEMA_FILES from the migrations
-- dir") — here fixed forward by tracking the DDL so a DR rebuild / new env /
-- teammate local can reproduce prod.
--
-- ADDITIVE and IDEMPOTENT (IF NOT EXISTS): a no-op against prod, which already
-- has both tables. DDL pulled read-only from prod's information_schema /
-- pg_indexes / pg_constraint, so column types, defaults, keys, and indexes match
-- production exactly.

CREATE TABLE IF NOT EXISTS "CommunityNeighborhood" (
  "id"            TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "communitySlug" TEXT NOT NULL,
  "name"          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "CommunityNeighborhood_communitySlug_name_key"
  ON "CommunityNeighborhood" ("communitySlug", "name");
CREATE INDEX IF NOT EXISTS "CommunityNeighborhood_community_idx"
  ON "CommunityNeighborhood" ("communitySlug");

CREATE TABLE IF NOT EXISTS "CrawlSiteHint" (
  "id"        TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  "domain"    TEXT NOT NULL,
  "hint"      TEXT NOT NULL,
  "source"    TEXT NOT NULL DEFAULT 'manual',
  "sourceId"  TEXT,
  "active"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "CrawlSiteHint_domain_idx"
  ON "CrawlSiteHint" ("domain") WHERE ("active" = TRUE);
