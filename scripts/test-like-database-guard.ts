/**
 * The connection guard the verification scripts share: refuse to run unless
 * the resolved connection looks like the throwaway test database (loopback
 * host, `sslmode=disable`, "test" in the database name), or the operator
 * passed `--allow-production` deliberately. These scripts load `.env.prod`
 * first, so a bare run must never reach production by accident.
 */
import { resolvePgConfig } from '@/lib/db-config';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertTestLikeDatabase(script: string, allowProduction: boolean): void {
  if (allowProduction) {
    console.warn(`[${script}] --allow-production supplied: skipping the test-database connection guard. Confirm DATABASE_URL/POSTGRES_URL/PGHOST is the intended target.`);
    return;
  }
  const config = resolvePgConfig();
  const isLoopback = config != null && LOOPBACK_HOSTS.has(config.host.toLowerCase());
  const looksLikeTestDb = config != null && config.ssl === false && isLoopback && /test/i.test(config.database);
  if (!looksLikeTestDb) {
    throw new Error(
      `Refusing to run ${script}: the resolved database connection (host: ${config?.host ?? '<none>'}, database: ${config?.database ?? '<none>'}) ` +
        'does not look like a throwaway test database (a loopback host with sslmode=disable and "test" in the database name). ' +
        'Pass --allow-production to run against another target deliberately.',
    );
  }
}
