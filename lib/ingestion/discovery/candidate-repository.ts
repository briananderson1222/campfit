/**
 * lib/ingestion/discovery/candidate-repository.ts — persistence for the
 * provider-candidate review queue (I22 / #52).
 *
 * Storage is a single ADDITIVE table, "ProviderCandidate". It is deliberately
 * self-contained: it references no existing model (an approved candidate points
 * at the Provider it created by id, but there is no FK, so this table does not
 * touch the claim store / verification / admin-review models that are changing
 * on feat/verification-authority, and it can merge in any order relative to that
 * work). The canonical production migration is
 * prisma/migrations/013_provider_candidates.sql, which contains the SAME DDL as
 * PROVIDER_CANDIDATE_SCHEMA_SQL below. That migration is NOT yet wired into
 * scripts/test-db-reset.ts's SCHEMA_FILES because that file is being modified on
 * the owner's branch; `ensureProviderCandidateSchema()` (idempotent CREATE TABLE
 * IF NOT EXISTS) provisions the table for the discovery CLI and the integration
 * test without editing that shared file. See the PR body's coordination note.
 *
 * The two write paths are strictly separated for the approval gate (R3/AC3):
 *   - `enqueueCandidate` only ever inserts a ProviderCandidate row. It NEVER
 *     creates a Provider.
 *   - `approveProviderCandidate` is the ONLY path that creates a Provider, and
 *     it is an explicit, human-initiated action guarded by a row lock + status
 *     check so a candidate can be promoted at most once.
 *
 * campfit#93 additive extension: `locale`/`aggregatorSourceId`/
 * `provenanceExcerpt`/`provenanceLocator`/`snapshotSourceRef` (all nullable,
 * optional on `EnqueueCandidateInput`) let the NEW aggregator-discovery lane
 * (`lib/ingestion/aggregator/**`) enqueue into this SAME queue instead of
 * forking a parallel candidate table. Existing callers (e.g.
 * `denver-rec-centers` via `runDiscovery`) are unaffected — they simply never
 * pass these optional fields, which are then written as NULL. Canonical DDL
 * for these columns lives in prisma/migrations/017_aggregator_discovery.sql.
 */
import type { Pool, PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { normalizeDomain, normalizeName } from "./dedupe";
import type { DedupeTarget } from "./dedupe";

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * Canonical DDL for the queue table. Kept identical to
 * prisma/migrations/013_provider_candidates.sql. Idempotent so it is safe to
 * run at CLI/test startup regardless of whether the migration has been applied.
 */
export const PROVIDER_CANDIDATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS "ProviderCandidate" (
    id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name                   TEXT NOT NULL,
    "normalizedName"       TEXT NOT NULL,
    "websiteUrl"           TEXT,
    domain                 TEXT,
    city                   TEXT,
    neighborhood           TEXT,
    "communitySlug"        TEXT NOT NULL DEFAULT 'denver',
    status                 TEXT NOT NULL DEFAULT 'PENDING',
    "possibleDuplicateOfProviderId" TEXT,
    "possibleDuplicateOfName"       TEXT,
    "duplicateReason"      TEXT,
    "sourceKey"            TEXT NOT NULL,
    "sourceLabel"          TEXT NOT NULL,
    "discoveryQuery"       TEXT,
    "retrievedAt"          TIMESTAMPTZ NOT NULL,
    "approvedProviderId"   TEXT,
    "reviewedAt"           TIMESTAMPTZ,
    "reviewedBy"           TEXT,
    "reviewerNotes"        TEXT,
    "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS "ProviderCandidate_status_idx" ON "ProviderCandidate"(status);
  CREATE INDEX IF NOT EXISTS "ProviderCandidate_domain_idx" ON "ProviderCandidate"(domain);
  CREATE INDEX IF NOT EXISTS "ProviderCandidate_normalizedName_idx" ON "ProviderCandidate"("normalizedName");
  CREATE INDEX IF NOT EXISTS "ProviderCandidate_community_idx" ON "ProviderCandidate"("communitySlug", status);

  -- campfit#93 additive extension (mirrors prisma/migrations/017_aggregator_discovery.sql):
  ALTER TABLE "ProviderCandidate" ADD COLUMN IF NOT EXISTS "locale" TEXT;
  ALTER TABLE "ProviderCandidate" ADD COLUMN IF NOT EXISTS "aggregatorSourceId" TEXT;
  ALTER TABLE "ProviderCandidate" ADD COLUMN IF NOT EXISTS "provenanceExcerpt" TEXT;
  ALTER TABLE "ProviderCandidate" ADD COLUMN IF NOT EXISTS "provenanceLocator" TEXT;
  ALTER TABLE "ProviderCandidate" ADD COLUMN IF NOT EXISTS "snapshotSourceRef" TEXT;
  CREATE INDEX IF NOT EXISTS "ProviderCandidate_aggregatorSourceId_idx" ON "ProviderCandidate"("aggregatorSourceId");
`;

export async function ensureProviderCandidateSchema(pool: Pool = getPool()): Promise<void> {
  await pool.query(PROVIDER_CANDIDATE_SCHEMA_SQL);
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface ProviderCandidateRow {
  id: string;
  name: string;
  normalizedName: string;
  websiteUrl: string | null;
  domain: string | null;
  city: string | null;
  neighborhood: string | null;
  communitySlug: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  possibleDuplicateOfProviderId: string | null;
  possibleDuplicateOfName: string | null;
  duplicateReason: string | null;
  sourceKey: string;
  sourceLabel: string;
  discoveryQuery: string | null;
  retrievedAt: Date;
  approvedProviderId: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewerNotes: string | null;
  createdAt: Date;
  /** campfit#93: aggregator-sourced candidates only (null for curated-source candidates). */
  locale: string | null;
  aggregatorSourceId: string | null;
  provenanceExcerpt: string | null;
  provenanceLocator: string | null;
  snapshotSourceRef: string | null;
}

export interface EnqueueCandidateInput {
  name: string;
  websiteUrl: string | null;
  city: string | null;
  neighborhood?: string | null;
  communitySlug: string;
  sourceKey: string;
  sourceLabel: string;
  discoveryQuery: string | null;
  retrievedAt: Date;
  /** Set when dedupe flagged this as a near-duplicate of an existing provider. */
  possibleDuplicateOfProviderId?: string | null;
  possibleDuplicateOfName?: string | null;
  duplicateReason?: string | null;
  /** campfit#93: set only by the aggregator-discovery lane. */
  locale?: string | null;
  aggregatorSourceId?: string | null;
  provenanceExcerpt?: string | null;
  provenanceLocator?: string | null;
  snapshotSourceRef?: string | null;
}

// ── Dedupe key loaders ───────────────────────────────────────────────────────

/** Onboarded providers in a community, as dedupe targets (name + domain). */
export async function listProviderDedupeTargets(
  communitySlug: string,
  pool: Pool = getPool(),
): Promise<DedupeTarget[]> {
  const { rows } = await pool.query<{ id: string; name: string; domain: string | null }>(
    `SELECT id, name, domain FROM "Provider"
     WHERE "communitySlug" = $1 AND "archivedAt" IS NULL`,
    [communitySlug],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain }));
}

/** Already-queued PENDING candidates in a community, as dedupe targets. */
export async function listPendingCandidateDedupeTargets(
  communitySlug: string,
  pool: Pool = getPool(),
): Promise<DedupeTarget[]> {
  const { rows } = await pool.query<{ id: string; name: string; domain: string | null }>(
    `SELECT id, name, domain FROM "ProviderCandidate"
     WHERE "communitySlug" = $1 AND status = 'PENDING'`,
    [communitySlug],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain }));
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Insert one candidate into the queue. This is the ONLY thing discovery does to
 * the database — it never creates a Provider. Returns the inserted row.
 */
export async function enqueueCandidate(
  input: EnqueueCandidateInput,
  pool: Pool = getPool(),
): Promise<ProviderCandidateRow> {
  const { rows } = await pool.query<ProviderCandidateRow>(
    `INSERT INTO "ProviderCandidate"
       (name, "normalizedName", "websiteUrl", domain, city, neighborhood,
        "communitySlug", status,
        "possibleDuplicateOfProviderId", "possibleDuplicateOfName", "duplicateReason",
        "sourceKey", "sourceLabel", "discoveryQuery", "retrievedAt",
        "locale", "aggregatorSourceId", "provenanceExcerpt", "provenanceLocator", "snapshotSourceRef")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      input.name,
      normalizeName(input.name),
      input.websiteUrl,
      normalizeDomain(input.websiteUrl),
      input.city,
      input.neighborhood ?? null,
      input.communitySlug,
      input.possibleDuplicateOfProviderId ?? null,
      input.possibleDuplicateOfName ?? null,
      input.duplicateReason ?? null,
      input.sourceKey,
      input.sourceLabel,
      input.discoveryQuery,
      input.retrievedAt,
      input.locale ?? null,
      input.aggregatorSourceId ?? null,
      input.provenanceExcerpt ?? null,
      input.provenanceLocator ?? null,
      input.snapshotSourceRef ?? null,
    ],
  );
  return rows[0];
}

/** Pending candidates for a community, newest first — the review queue. */
export async function getPendingCandidates(
  communitySlug: string,
  pool: Pool = getPool(),
): Promise<ProviderCandidateRow[]> {
  const { rows } = await pool.query<ProviderCandidateRow>(
    `SELECT * FROM "ProviderCandidate"
     WHERE "communitySlug" = $1 AND status = 'PENDING'
     ORDER BY "createdAt" DESC`,
    [communitySlug],
  );
  return rows;
}

export async function getCandidate(
  id: string,
  pool: Pool = getPool(),
): Promise<ProviderCandidateRow | null> {
  const { rows } = await pool.query<ProviderCandidateRow>(
    `SELECT * FROM "ProviderCandidate" WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export class CandidateNotPendingError extends Error {
  constructor(public readonly status: string) {
    super(`Candidate is not PENDING (status: ${status}); refusing to act on it.`);
    this.name = "CandidateNotPendingError";
  }
}

export interface ApproveCandidateResult {
  providerId: string;
  providerSlug: string;
}

/**
 * The approval gate (R3/AC3). The ONLY path that turns a candidate into a real
 * Provider, and only when a human triggers it. Runs in a single transaction:
 * locks the candidate row, verifies it is still PENDING (so it can be approved
 * at most once — a double-approve or approving a rejected candidate throws),
 * inserts a Provider (unique slug generated within the same transaction), and
 * flips the candidate to APPROVED with the new providerId + reviewer provenance.
 */
export async function approveProviderCandidate(
  id: string,
  opts: { approvedBy: string; reviewerNotes?: string | null },
  pool: Pool = getPool(),
): Promise<ApproveCandidateResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: locked } = await client.query<ProviderCandidateRow>(
      `SELECT * FROM "ProviderCandidate" WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const candidate = locked[0];
    if (!candidate) {
      throw new Error(`Candidate ${id} not found`);
    }
    if (candidate.status !== "PENDING") {
      throw new CandidateNotPendingError(candidate.status);
    }

    const slug = await makeUniqueProviderSlug(client, candidate.name);

    const { rows: providerRows } = await client.query<{ id: string; slug: string }>(
      `INSERT INTO "Provider"
         (name, slug, "websiteUrl", domain, city, neighborhood, notes,
          "crawlRootUrl", "communitySlug")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, slug`,
      [
        candidate.name,
        slug,
        candidate.websiteUrl,
        candidate.domain,
        candidate.city,
        candidate.neighborhood,
        `Onboarded from discovery source "${candidate.sourceLabel}" (${candidate.sourceKey}).`,
        candidate.websiteUrl,
        candidate.communitySlug,
      ],
    );
    const provider = providerRows[0];

    await client.query(
      `UPDATE "ProviderCandidate"
         SET status = 'APPROVED', "approvedProviderId" = $2,
             "reviewedAt" = now(), "reviewedBy" = $3, "reviewerNotes" = $4
       WHERE id = $1`,
      [id, provider.id, opts.approvedBy, opts.reviewerNotes?.trim() || null],
    );

    await client.query("COMMIT");
    return { providerId: provider.id, providerSlug: provider.slug };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Reject a candidate (human action). No Provider is created. */
export async function rejectProviderCandidate(
  id: string,
  opts: { reviewedBy: string; reviewerNotes?: string | null },
  pool: Pool = getPool(),
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE "ProviderCandidate"
       SET status = 'REJECTED', "reviewedAt" = now(), "reviewedBy" = $2, "reviewerNotes" = $3
     WHERE id = $1 AND status = 'PENDING'`,
    [id, opts.reviewedBy, opts.reviewerNotes?.trim() || null],
  );
  if (rowCount === 0) {
    const existing = await getCandidate(id, pool);
    if (!existing) throw new Error(`Candidate ${id} not found`);
    throw new CandidateNotPendingError(existing.status);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function makeUniqueProviderSlug(client: PoolClient, name: string): Promise<string> {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "provider";
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await client.query(`SELECT 1 FROM "Provider" WHERE slug = $1`, [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}
