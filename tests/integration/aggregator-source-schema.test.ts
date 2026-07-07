/**
 * tests/integration/aggregator-source-schema.test.ts — campfit#93 Wave 2
 * Task 2.1 acceptance suite for `AggregatorSource` registration + the
 * repository-level ToS-decision gate (R1/AC1's repository half).
 *
 * Coverage:
 *   - `ensureAggregatorSourceSchema` provisions the table idempotently.
 *   - `createAggregatorSource` defaults `status: 'REGISTERED'`,
 *     `tosDecision: null`.
 *   - `canFetchAggregator` is `false` for a freshly-registered row and for a
 *     `'DECLINED'` row, `true` only after `recordTosDecision(id,
 *     {decision:'APPROVED', reviewedBy})`.
 *   - `recordTosDecision` sets `tosReviewedAt`/`tosReviewedBy`/`tosNotes` and
 *     flips `status` correctly for both decisions.
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`, and `beforeAll` awaits
 * `assertTestDatabase()` before anything destructive runs (see
 * `provider-discovery.test.ts` for the established precedent). The
 * "AggregatorSource" table is provisioned here via the same idempotent
 * `ensureAggregatorSourceSchema()` the admin routes use — the additive
 * migration 017 is intentionally not wired into
 * scripts/test-db-reset.ts's SCHEMA_FILES (see that migration's own header
 * comment; tracked under campfit#98).
 */
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  canFetchAggregator,
  createAggregatorSource,
  ensureAggregatorSourceSchema,
  getAggregatorSource,
  listAggregatorSources,
  recordTosDecision,
} from "@/lib/ingestion/aggregator/aggregator-repository";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

const REVIEWER = "reviewer@campfit.test";

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
  await ensureAggregatorSourceSchema(pool);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "AggregatorSource" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

describe("ensureAggregatorSourceSchema", () => {
  it("provisions the table idempotently", async () => {
    await expect(ensureAggregatorSourceSchema(pool)).resolves.not.toThrow();
    await expect(ensureAggregatorSourceSchema(pool)).resolves.not.toThrow();
  });
});

describe("createAggregatorSource", () => {
  it("defaults status: 'REGISTERED' and tosDecision: null", async () => {
    const row = await createAggregatorSource(
      { name: "Camp Finder Directory", url: "https://campfinder.example", createdBy: "admin@campfit.test" },
      pool,
    );
    expect(row.status).toBe("REGISTERED");
    expect(row.tosDecision).toBeNull();
    expect(row.communitySlug).toBe("denver");
    expect(row.maxPages).toBe(20);
    expect(row.maxDepth).toBe(2);

    const fetched = await getAggregatorSource(row.id, pool);
    expect(fetched?.id).toBe(row.id);
  });

  it("lists sources scoped by community", async () => {
    await createAggregatorSource({ name: "Denver Aggregator", url: "https://denver-agg.example", communitySlug: "denver" }, pool);
    await createAggregatorSource({ name: "Boulder Aggregator", url: "https://boulder-agg.example", communitySlug: "boulder" }, pool);

    const denverOnly = await listAggregatorSources("denver", pool);
    expect(denverOnly.map((r) => r.name)).toEqual(["Denver Aggregator"]);

    const all = await listAggregatorSources(undefined, pool);
    expect(all.length).toBe(2);
  });
});

describe("canFetchAggregator — the repository-level ToS gate (AC1)", () => {
  it("is false for a freshly-registered row", async () => {
    const row = await createAggregatorSource(
      { name: "Fresh Aggregator", url: "https://fresh-agg.example" },
      pool,
    );
    expect(canFetchAggregator(row)).toBe(false);
  });

  it("is false for a row with a DECLINED ToS decision", async () => {
    const created = await createAggregatorSource(
      { name: "Declined Aggregator", url: "https://declined-agg.example" },
      pool,
    );
    const decided = await recordTosDecision(
      created.id,
      { decision: "DECLINED", reviewedBy: REVIEWER, notes: "ToS forbids automated access." },
      pool,
    );
    expect(decided).not.toBeNull();
    expect(canFetchAggregator(decided!)).toBe(false);
    expect(decided!.status).toBe("DECLINED");
    expect(decided!.tosDecision).toBe("DECLINED");
    expect(decided!.tosReviewedBy).toBe(REVIEWER);
    expect(decided!.tosReviewedAt).toBeTruthy();
    expect(decided!.tosNotes).toBe("ToS forbids automated access.");
  });

  it("is true only after recordTosDecision APPROVED", async () => {
    const created = await createAggregatorSource(
      { name: "Approved Aggregator", url: "https://approved-agg.example" },
      pool,
    );
    expect(canFetchAggregator(created)).toBe(false);

    const decided = await recordTosDecision(
      created.id,
      { decision: "APPROVED", reviewedBy: REVIEWER },
      pool,
    );
    expect(decided).not.toBeNull();
    expect(canFetchAggregator(decided!)).toBe(true);
    expect(decided!.status).toBe("ACTIVE");
    expect(decided!.tosDecision).toBe("APPROVED");
    expect(decided!.tosReviewedBy).toBe(REVIEWER);
    expect(decided!.tosReviewedAt).toBeTruthy();

    // Re-reading fresh from the DB (not the caller's in-memory row) confirms
    // the gate is a durable, re-checkable fact — not just a return value.
    const reread = await getAggregatorSource(created.id, pool);
    expect(canFetchAggregator(reread!)).toBe(true);
  });
});
