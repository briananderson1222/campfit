/**
 * scripts/test-db-reset.ts — provision (or re-provision) the throwaway
 * integration-test Postgres database.
 *
 * Connects ONLY to `process.env.TEST_DATABASE_URL` — this is destructive
 * (`DROP SCHEMA public CASCADE`) and must never be able to reach the real
 * Supabase instance behind `DATABASE_URL`/`PGHOST`, so there is no fallback.
 *
 * Schema source of truth is the hand-written SQL in `prisma/migrations`, run
 * through node-pg-migrate. `prisma/schema.prisma` / `prisma db push` is not
 * used because application database access and migrations remain raw SQL.
 *
 * Shared by two callers:
 *  - the `test:db:reset` CLI script (this file, run directly via tsx)
 *  - `tests/integration/global-setup.ts` (imports `resetTestDatabase`)
 */
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { Client } from "pg";
import {
  MIGRATIONS_DIR,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from "./db-migrations.js";

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
    await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      migrationsTable: MIGRATIONS_TABLE,
      migrationsSchema: MIGRATIONS_SCHEMA,
      schema: MIGRATIONS_SCHEMA,
      direction: "up",
      checkOrder: false,
      verbose: false,
    });
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
