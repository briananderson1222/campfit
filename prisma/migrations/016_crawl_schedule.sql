-- 016_crawl_schedule.sql — singleton scheduled-crawl config row (campfit#92).
--
-- ADDITIVE ONLY. Creates one new self-contained table, "CrawlSchedule", with
-- no foreign keys into any existing table — a global on/off + priority +
-- batch-size toggle for the `/api/cron/crawl` route (a later wave), not a
-- per-community schedule (explicitly out of scope for this pass — see the
-- plan's Definition Of Done). Follows
-- 013_provider_candidates.sql's new-table convention (idempotent
-- `CREATE TABLE IF NOT EXISTS`, no dependency on any other migration's
-- ordering).
--
-- Singleton enforced two ways: a real CHECK constraint pinning the only
-- allowed primary key to the literal 'default' (defense-in-depth, mirroring
-- scripts/test-db-reset.ts's own sentinel-table discipline), plus a
-- bootstrap `INSERT ... ON CONFLICT DO NOTHING` so the row always exists
-- after this migration runs — no "no schedule yet" branch is ever needed in
-- lib/admin/schedule-repository.ts or any caller.
--
-- "priority" stays a plain TEXT (no DB-level enum/CHECK), matching
-- "CrawlRun".trigger/status's existing convention — the TS-side union type
-- (lib/admin/schedule-repository.ts) is the real constraint, not the schema.

CREATE TABLE IF NOT EXISTS "CrawlSchedule" (
  id          TEXT PRIMARY KEY DEFAULT 'default',
  enabled     BOOLEAN NOT NULL DEFAULT false,
  priority    TEXT NOT NULL DEFAULT 'stale',
  "batchSize" INT NOT NULL DEFAULT 5,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedBy" TEXT,
  CONSTRAINT "CrawlSchedule_singleton_ck" CHECK (id = 'default')
);

INSERT INTO "CrawlSchedule" (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;
