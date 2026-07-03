/**
 * tests/integration/verified-coverage-metric.test.ts — AC3 for
 * `getVerifiedCoverageMetric` (lib/admin/metrics-repository.ts), against a
 * real throwaway Postgres so the JSON-path SQL is proven, not just mocked.
 *
 * The metric's SQL is cross-checked two independent ways over the same seeded
 * data (AC3 "matches an independent direct count/query"):
 *   1. Known-by-construction counts (we seed a fixed mix).
 *   2. `isFullyVerified()` (lib/admin/verification.ts) run in JS over each
 *      seeded camp's fieldSources — a different implementation of the same
 *      "every required field attested" rule than the SQL under test.
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`; `beforeAll` awaits `assertTestDatabase()`.
 * The module under test keeps using `@/lib/db`'s production pool, remapped to
 * the test database by `global-setup.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getVerifiedCoverageMetric } from "@/lib/admin/metrics-repository";
import {
  REQUIRED_FOR_VERIFIED,
  isFullyVerified,
} from "@/lib/admin/verification";
import type { FieldSource } from "@/lib/types";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

const ATTEST = "2026-01-15T00:00:00.000Z";

/** fieldSources JSON that attests exactly the given fields (approvedAt set). */
function attest(fields: readonly string[]): Record<string, FieldSource> {
  const out: Record<string, FieldSource> = {};
  for (const f of fields) {
    out[f] = { approvedAt: ATTEST } as FieldSource;
  }
  return out;
}

const ALL = REQUIRED_FOR_VERIFIED;
const ALL_BUT_ONE = REQUIRED_FOR_VERIFIED.slice(0, -1);

interface Seed {
  slug: string;
  community: string;
  fieldSources: Record<string, FieldSource> | null;
}

const SEEDS: Seed[] = [
  { slug: "denver-full-1", community: "denver", fieldSources: attest(ALL) },
  { slug: "denver-full-2", community: "denver", fieldSources: attest(ALL) },
  { slug: "denver-partial", community: "denver", fieldSources: attest(ALL_BUT_ONE) },
  { slug: "denver-none", community: "denver", fieldSources: null },
  { slug: "boulder-full", community: "boulder", fieldSources: attest(ALL) },
];

async function seedCamps(): Promise<void> {
  const pool = getTestPool();
  for (const s of SEEDS) {
    await pool.query(
      `INSERT INTO "Camp" (id, slug, name, "campType", category, "communitySlug", "fieldSources")
       VALUES ($1, $2, $3, 'SUMMER_DAY', 'SPORTS', $4, $5::jsonb)`,
      [
        randomUUID(),
        s.slug,
        s.slug,
        s.community,
        s.fieldSources ? JSON.stringify(s.fieldSources) : null,
      ],
    );
  }
}

/** Independent JS oracle: how many seeds (in scope) are fully verified. */
function expectedVerified(scope?: string) {
  const inScope = SEEDS.filter((s) => !scope || s.community === scope);
  const verified = inScope.filter((s) =>
    isFullyVerified({}, s.fieldSources),
  ).length;
  return { total: inScope.length, verified };
}

beforeAll(async () => {
  await assertTestDatabase();
});

afterEach(async () => {
  await getTestPool().query(`TRUNCATE TABLE "Camp" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

describe("getVerifiedCoverageMetric (AC3)", () => {
  it("site-wide count/% matches the independent JS isFullyVerified oracle", async () => {
    await seedCamps();

    const metric = await getVerifiedCoverageMetric();
    const oracle = expectedVerified();

    // Known-by-construction: 3 of 5 fully attested → 60%.
    expect(oracle).toEqual({ total: 5, verified: 3 });
    expect(metric.total).toBe(oracle.total);
    expect(metric.verified).toBe(oracle.verified);
    expect(metric.pct).toBe(60);
  });

  it("scopes to a moderator's communities", async () => {
    await seedCamps();

    const denver = await getVerifiedCoverageMetric(["denver"]);
    expect(denver).toMatchObject(expectedVerified("denver")); // 2 of 4
    expect(denver.pct).toBe(50);

    const boulder = await getVerifiedCoverageMetric(["boulder"]);
    expect(boulder).toMatchObject(expectedVerified("boulder")); // 1 of 1
    expect(boulder.pct).toBe(100);
  });

  it("a single missing attestation blocks verified — the strict gate", async () => {
    // Only the partial camp: 8 of 9 attested must NOT count as verified.
    await getTestPool().query(
      `INSERT INTO "Camp" (id, slug, name, "campType", category, "communitySlug", "fieldSources")
       VALUES ($1, 'lonely-partial', 'lonely-partial', 'SUMMER_DAY', 'SPORTS', 'denver', $2::jsonb)`,
      [randomUUID(), JSON.stringify(attest(ALL_BUT_ONE))],
    );
    const metric = await getVerifiedCoverageMetric();
    expect(metric).toEqual({ total: 1, verified: 0, pct: 0 });
  });

  it("returns zeroes (never divides by zero) on an empty catalog", async () => {
    expect(await getVerifiedCoverageMetric()).toEqual({
      total: 0,
      verified: 0,
      pct: 0,
    });
  });
});
