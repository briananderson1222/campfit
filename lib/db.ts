/**
 * lib/db.ts — pg Pool singleton
 *
 * Uses individual connection params to avoid URL-parsing issues with
 * special characters in the password. In development, reuses a global
 * pool across hot-reloads. In production (Vercel), creates a new pool
 * per cold-start.
 */

import { Pool } from "pg";
import { resolvePgConfig } from "./db-config";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

function createPool(): Pool {
  const config = resolvePgConfig();
  if (!config) {
    throw new Error("Missing database env vars: set PGHOST/PGUSER/PGPASSWORD or DATABASE_URL");
  }

  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: { rejectUnauthorized: false },
    // Keep small — Supabase free tier has a 60-connection limit.
    // A singleton is used globally so this is the max for the whole process.
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

export function getPool(): Pool {
  // Always use a singleton — safe in Next.js because each worker process
  // is a single Node.js instance. Prevents exhausting Supabase connections
  // during concurrent static page generation at build time.
  if (!global._pgPool) {
    global._pgPool = createPool();
  }
  return global._pgPool;
}
