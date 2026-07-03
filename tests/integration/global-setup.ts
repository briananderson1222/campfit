/**
 * tests/integration/global-setup.ts — Vitest `globalSetup` for the
 * integration suite.
 *
 * Runs once per `vitest run` invocation, before any test file is loaded,
 * and does two things:
 *
 *  1. Re-provisions the throwaway `TEST_DATABASE_URL` Postgres database
 *     (reusing `scripts/test-db-reset.ts`'s `resetTestDatabase` rather than
 *     duplicating the schema-file ordering here).
 *  2. Remaps env vars so that once test files import `@/lib/db`,
 *     `resolvePgConfig()` (`lib/db-config.ts`) resolves to the throwaway
 *     test database instead of a developer's local `.env.local`
 *     `PGHOST`/`PGUSER`/`PGPASSWORD` (which point at the real Supabase
 *     instance). This is the isolation mechanism — no production file
 *     (`lib/db.ts`, `lib/db-config.ts`) is modified to support tests.
 */
import { getTestDatabaseUrl, resetTestDatabase } from "../../scripts/test-db-reset";

export default async function setup() {
  const testDatabaseUrl = getTestDatabaseUrl();

  // `resolvePgConfig()` prefers PGHOST/PGUSER/PGPASSWORD over DATABASE_URL,
  // so those must be cleared or a developer's real Supabase credentials
  // would win over the DATABASE_URL remap below.
  delete process.env.PGHOST;
  delete process.env.PGUSER;
  delete process.env.PGPASSWORD;
  delete process.env.PGPORT;
  delete process.env.PGDATABASE;
  process.env.DATABASE_URL = testDatabaseUrl;

  await resetTestDatabase();
}
