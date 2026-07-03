/**
 * tests/integration/test-db.ts — shared test-owned Postgres pool for
 * integration-test seeding/truncation/assertion queries.
 *
 * F1 defense-in-depth, layer (b): every destructive or seed SQL statement in
 * `tests/integration/*.test.ts` must go through `getTestPool()` below, not
 * the shared `@/lib/db` pool. This pool is built directly from
 * `getTestDatabaseUrl()` (`scripts/test-db-reset.ts`), independent of
 * `global-setup.ts`'s env-var remap of `DATABASE_URL`/`PGHOST` — so even if
 * `globalSetup` is bypassed (a different `--config`, a future test-runner
 * change, a harness that skips Vitest config discovery entirely), this pool
 * still can only ever point at `TEST_DATABASE_URL`.
 *
 * Layer (a) is `resetTestDatabase()` (`scripts/test-db-reset.ts`) creating a
 * sentinel table, `"_campfit_test_db_marker"`, after (re)provisioning.
 * `assertTestDatabase()` below — which every test file's `beforeAll` must
 * await before any destructive statement runs — confirms that sentinel
 * exists on whatever database `TEST_DATABASE_URL` currently resolves to. If
 * it's missing (e.g. `TEST_DATABASE_URL` points at a database that was never
 * provisioned via `resetTestDatabase()`, such as a stray or misconfigured
 * connection string), this throws loudly and nothing destructive runs.
 *
 * The module under test (`lib/admin/review-apply.ts` and everything it
 * calls) is unaffected by this file — it keeps using `@/lib/db`'s shared
 * pool exactly as it does outside of tests; isolation for *that* pool is
 * still `global-setup.ts`'s env remap. This file only concerns the test
 * file's own seed/truncate/assert queries, which must not depend on that
 * remap having happened.
 */
import { Pool } from "pg";

import { getTestDatabaseUrl } from "../../scripts/test-db-reset";

let pool: Pool | undefined;
let verified = false;

/** The test-owned pool — built from `TEST_DATABASE_URL` directly, never `@/lib/db`. */
export function getTestPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getTestDatabaseUrl(), ssl: false });
  }
  return pool;
}

/**
 * Must be awaited (e.g. from a top-level `beforeAll`) before any
 * destructive/seed statement runs. Throws if the `"_campfit_test_db_marker"`
 * sentinel table written by `resetTestDatabase()` is missing. Cheap to call
 * repeatedly — verification result is cached per test-worker process.
 */
export async function assertTestDatabase(): Promise<void> {
  if (verified) return;
  const testPool = getTestPool();
  const result = await testPool.query<{ marker: string | null }>(
    `SELECT to_regclass('public."_campfit_test_db_marker"')::text AS marker`,
  );
  if (!result.rows[0]?.marker) {
    throw new Error(
      'Refusing to run destructive/seed test SQL: the "_campfit_test_db_marker" ' +
        "sentinel table is missing from the database TEST_DATABASE_URL points at. " +
        "This means that database was not provisioned by " +
        "scripts/test-db-reset.ts's resetTestDatabase() (e.g. globalSetup was " +
        "bypassed, or TEST_DATABASE_URL is misconfigured/points at a non-test " +
        "database). Run `npm run test:db:reset` against the intended throwaway " +
        "database before running this suite.",
    );
  }
  verified = true;
}

/** Closes the test-owned pool. Call from a top-level `afterAll`. */
export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
  verified = false;
}
