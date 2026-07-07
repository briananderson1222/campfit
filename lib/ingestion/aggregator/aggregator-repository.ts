/**
 * lib/ingestion/aggregator/aggregator-repository.ts — persistence for
 * `AggregatorSource` registration + the ToS-decision gate (campfit#93, R1).
 *
 * `AggregatorSource` is a single ADDITIVE, self-contained table (no FK — see
 * prisma/migrations/017_aggregator_discovery.sql's header comment), following
 * the exact pattern `lib/ingestion/discovery/candidate-repository.ts`
 * established for `ProviderCandidate`: the canonical DDL lives in a migration
 * file, and `ensureAggregatorSourceSchema()` (idempotent `CREATE TABLE IF NOT
 * EXISTS`) provisions the same table for the CLI/tests without depending on
 * `scripts/test-db-reset.ts`'s `SCHEMA_FILES` (see the migration's own
 * MERGE-ORDERING NOTE; tracked under campfit#98).
 *
 * `canFetchAggregator` is the single source of truth for AC1's structural ToS
 * gate: it is a pure function of the row's `tosDecision` column, re-read fresh
 * from the database by every caller that is about to fetch (never trusted from
 * a caller-supplied/stale row) — see `runAggregatorDiscovery`
 * (aggregator-extraction.ts, Wave 3) and the discover route (Wave 4), both of
 * which call `getAggregatorSource` immediately before checking this function.
 */
import type { Pool } from "pg";

import { getPool } from "@/lib/db";
import type {
  AggregatorSourceRow,
  CreateAggregatorSourceInput,
  TosDecisionInput,
} from "./types";

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * Canonical DDL for the "AggregatorSource" table. Kept identical to
 * prisma/migrations/017_aggregator_discovery.sql's CREATE TABLE statement.
 * Idempotent so it is safe to run at CLI/test/route startup regardless of
 * whether the migration has been applied.
 */
export const AGGREGATOR_SOURCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS "AggregatorSource" (
    id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name             TEXT NOT NULL,
    url              TEXT NOT NULL,
    "communitySlug"  TEXT NOT NULL DEFAULT 'denver',
    "maxPages"       INTEGER NOT NULL DEFAULT 20,
    "maxDepth"       INTEGER NOT NULL DEFAULT 2,
    status           TEXT NOT NULL DEFAULT 'REGISTERED',
    "tosDecision"    TEXT,
    "tosReviewedBy"  TEXT,
    "tosReviewedAt"  TIMESTAMPTZ,
    "tosNotes"       TEXT,
    "createdBy"      TEXT,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS "AggregatorSource_status_idx" ON "AggregatorSource"(status);
  CREATE INDEX IF NOT EXISTS "AggregatorSource_community_idx" ON "AggregatorSource"("communitySlug");
`;

export async function ensureAggregatorSourceSchema(pool: Pool = getPool()): Promise<void> {
  await pool.query(AGGREGATOR_SOURCE_SCHEMA_SQL);
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function createAggregatorSource(
  input: CreateAggregatorSourceInput,
  pool: Pool = getPool(),
): Promise<AggregatorSourceRow> {
  const { rows } = await pool.query<AggregatorSourceRow>(
    `INSERT INTO "AggregatorSource"
       (name, url, "communitySlug", "maxPages", "maxDepth", "createdBy")
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      input.name,
      input.url,
      input.communitySlug ?? "denver",
      input.maxPages ?? 20,
      input.maxDepth ?? 2,
      input.createdBy ?? null,
    ],
  );
  return rows[0];
}

export async function getAggregatorSource(
  id: string,
  pool: Pool = getPool(),
): Promise<AggregatorSourceRow | null> {
  const { rows } = await pool.query<AggregatorSourceRow>(
    `SELECT * FROM "AggregatorSource" WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listAggregatorSources(
  communitySlug?: string,
  pool: Pool = getPool(),
): Promise<AggregatorSourceRow[]> {
  if (communitySlug) {
    const { rows } = await pool.query<AggregatorSourceRow>(
      `SELECT * FROM "AggregatorSource" WHERE "communitySlug" = $1 ORDER BY "createdAt" DESC`,
      [communitySlug],
    );
    return rows;
  }
  const { rows } = await pool.query<AggregatorSourceRow>(
    `SELECT * FROM "AggregatorSource" ORDER BY "createdAt" DESC`,
  );
  return rows;
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Records the human ToS-review decision — the literal checkpoint R1/AC1
 * exists to force. Flips `status` to `'ACTIVE'` on `APPROVED` or `'DECLINED'`
 * on `DECLINED`; both outcomes are fully audited via
 * `tosReviewedBy`/`tosReviewedAt`/`tosNotes` regardless of which way the
 * decision goes, so a later re-decision (e.g. `DECLINED` -> `APPROVED`) is
 * never a silent gate removal.
 */
export async function recordTosDecision(
  id: string,
  input: TosDecisionInput,
  pool: Pool = getPool(),
): Promise<AggregatorSourceRow | null> {
  const status = input.decision === "APPROVED" ? "ACTIVE" : "DECLINED";
  const { rows } = await pool.query<AggregatorSourceRow>(
    `UPDATE "AggregatorSource"
       SET "tosDecision" = $2, "tosReviewedBy" = $3, "tosReviewedAt" = now(),
           "tosNotes" = $4, status = $5, "updatedAt" = now()
     WHERE id = $1
     RETURNING *`,
    [id, input.decision, input.reviewedBy, input.notes?.trim() || null, status],
  );
  return rows[0] ?? null;
}

/**
 * The single structural gate primitive (AC1): `true` only when a human has
 * recorded `tosDecision = 'APPROVED'` on THIS row. Every caller that is about
 * to fetch must re-read the row via `getAggregatorSource` immediately before
 * calling this — never trust a caller-supplied row that may be stale (see
 * `runAggregatorDiscovery`, Wave 3, and the discover route, Wave 4).
 */
export function canFetchAggregator(row: AggregatorSourceRow): boolean {
  return row.tosDecision === "APPROVED";
}
