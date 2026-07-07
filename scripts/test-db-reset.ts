/**
 * scripts/test-db-reset.ts — provision (or re-provision) the throwaway
 * integration-test Postgres database.
 *
 * Connects ONLY to `process.env.TEST_DATABASE_URL` — this is destructive
 * (`DROP SCHEMA public CASCADE`) and must never be able to reach the real
 * Supabase instance behind `DATABASE_URL`/`PGHOST`, so there is no fallback.
 *
 * Schema source of truth is the ordered set of hand-written SQL files below
 * (see the "Test DB Provisioning Plan" in the review-apply-module deliver
 * plan for the empirically-verified ordering) — `prisma/schema.prisma` /
 * `prisma db push` is not used because the Prisma schema is missing several
 * models (`CampChangeProposal`, `CrawlRun`, `CrawlMetric`,
 * `ProviderChangeProposal`, `CommunityModeratorAssignment`) that this SQL
 * covers.
 *
 * Shared by two callers:
 *  - the `test:db:reset` CLI script (this file, run directly via tsx)
 *  - `tests/integration/global-setup.ts` (imports `resetTestDatabase`)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/**
 * Ordered schema files — this order is load-bearing. `008` emits an
 * expected idempotent `NOTICE: relation "CampChangeLog" already exists,
 * skipping` because `scripts/sql/admin-schema.sql` (applied second) already
 * creates it; that NOTICE is not an error.
 */
const SCHEMA_FILES = [
  "prisma/migrations/001_initial_schema.sql",
  "scripts/sql/admin-schema.sql",
  "prisma/migrations/002_provider_and_field_sources.sql",
  "prisma/migrations/003_camp_reports.sql",
  "prisma/migrations/004_array_types_and_address.sql",
  "prisma/migrations/005_admin_trust_platform.sql",
  "prisma/migrations/006_provider_change_proposals.sql",
  "prisma/migrations/007_moderator_roles.sql",
  "prisma/migrations/008_provider_person_change_logs.sql",
  "prisma/migrations/009_survey_review_events.sql",
  "prisma/migrations/010_survey_review_sessions.sql",
  "prisma/migrations/011_proposal_applied_fields.sql",
  "prisma/migrations/012_claim_store_and_session_identity.sql",
  // NOTE: 013_provider_candidates.sql is pre-existing drift (not added to this
  // list) — tracked in campfit#98 (derive SCHEMA_FILES from the migrations
  // dir); not this task's to fix.
  "prisma/migrations/014_crawl_run_camp_log.sql",
  "prisma/migrations/015_proposal_snapshot_ref.sql",
  // 016_crawl_schedule.sql (campfit#92) is appended correctly here — it does
  // NOT fix 013_provider_candidates.sql's pre-existing drift above (still
  // tracked separately in campfit#98); only this plan's own new migration is
  // wired in.
  "prisma/migrations/016_crawl_schedule.sql",
  // NOTE: 017_aggregator_discovery.sql (campfit#93) is ALSO intentionally not
  // added to this list, for the same reason 013_provider_candidates.sql above
  // isn't: it ALTERs "ProviderCandidate", a table that (per the note above)
  // this SCHEMA_FILES list never actually creates via a run of
  // resetTestDatabase() — 013 itself is missing from this array. A migration
  // that ALTERs a table this list doesn't create could not be safely wired in
  // here without first fixing #98. Schema provisioning for the new
  // "AggregatorSource" table and the additive ProviderCandidate columns goes
  // through `ensureAggregatorSourceSchema()`/`ensureProviderCandidateSchema()`
  // (idempotent DDL) instead — see 017_aggregator_discovery.sql's own header
  // comment. Tracked under the same campfit#98.
  //
  // 018_review_batch_accept_audit.sql (campfit#51) is, by contrast, SAFE to
  // wire in directly: unlike 013/017, it creates a brand-new, self-contained
  // "ReviewBatchAcceptAudit" table with NO `ALTER` on any unwired table — it
  // adds no new #98 drift, so it is appended below rather than routed through
  // an idempotent-DDL helper.
  "prisma/migrations/018_review_batch_accept_audit.sql",
  // 019_provider_requires_render.sql (campfit#53, spa-ingestion) is, by the
  // SAME 018 precedent, safe to wire in directly: it's a single self-contained
  // `ALTER TABLE "Provider" ADD COLUMN` on a table 002 already creates (and
  // which IS in this list) — no new #98 drift.
  "prisma/migrations/019_provider_requires_render.sql",
];

/**
 * Sentinel table (F1, layer a of the defense-in-depth against a test suite's
 * destructive SQL reaching a non-test database): created only by this
 * function, after the throwaway database has been fully (re)provisioned.
 * `tests/integration/test-db.ts` (layer b) refuses to run anything
 * destructive/seed-related until it confirms this table exists on whatever
 * database `TEST_DATABASE_URL` currently points at — so a stray/misconfigured
 * `TEST_DATABASE_URL` that was never provisioned via `resetTestDatabase()`
 * (e.g. globalSetup bypassed, or pointed at a real database by mistake) fails
 * loudly instead of letting a TRUNCATE/ALTER run.
 */
const SENTINEL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "_campfit_test_db_marker" (
    "provisionedAt" timestamptz NOT NULL DEFAULT now()
  );
  TRUNCATE "_campfit_test_db_marker";
  INSERT INTO "_campfit_test_db_marker" DEFAULT VALUES;
`;

export function getTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. This reset is destructive " +
        '(`DROP SCHEMA public CASCADE`) and must never fall back to ' +
        "DATABASE_URL/PGHOST, which may point at the real Supabase " +
        "instance. Set TEST_DATABASE_URL to a throwaway Postgres " +
        "connection string before running this script."
    );
  }
  return url;
}

export async function resetTestDatabase(): Promise<void> {
  const connectionString = getTestDatabaseUrl();
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const relativePath of SCHEMA_FILES) {
      const sql = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      await client.query(sql);
    }
    // Written last, after every schema file has applied (a `DROP SCHEMA
    // public CASCADE` above would otherwise wipe it) — see SENTINEL_TABLE_SQL
    // for why this table exists.
    await client.query(SENTINEL_TABLE_SQL);
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`Resetting test database at ${getTestDatabaseUrl()}...`);
  await resetTestDatabase();
  console.log("Test database reset complete.");
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
