/**
 * lib/db.ts — pg Pool singleton
 *
 * Uses individual connection params to avoid URL-parsing issues with
 * special characters in the password. In development, reuses a global
 * pool across hot-reloads. In production (Vercel), creates a new pool
 * per cold-start.
 */

import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var _pgPool: Pool | undefined;
}

function createPool(): Pool {
  return new Pool({
    host: process.env.PGHOST ?? "aws-0-us-west-2.pooler.supabase.com",
    port: parseInt(process.env.PGPORT ?? "6543"),
    database: process.env.PGDATABASE ?? "postgres",
    user: process.env.PGUSER ?? "postgres.rpnzolnnhbzhuspwpajq",
    password: process.env.PGPASSWORD ?? "eDG*8dX-c#eD2Z2",
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
