/**
 * tests/integration/verified-coverage-metric.test.ts — AC3 for
 * `getVerifiedCoverageMetric` (lib/admin/metrics-repository.ts), against a
 * real throwaway Postgres so the SQL under test is proven, not just mocked.
 *
 * Verification-authority cutover (docs/verification-authority.md): this test
 * originally cross-checked the metric's SQL two independent ways over the
 * same seeded data — (1) known-by-construction counts, and (2)
 * `isFullyVerified()` (the now-deleted `lib/admin/verification.ts`) run in JS
 * over each seeded camp's `fieldSources`, a SECOND implementation of the same
 * "every required field attested" rule.
 *
 * That second, independent implementation no longer exists — and can't be
 * meaningfully resurrected — because the metric itself no longer re-derives
 * "verified" from `fieldSources` at all (see `metrics-repository.ts`'s
 * updated header comment): `Camp.dataConfidence` is now the SOLE,
 * already-computed output of `verification-authority.ts`'s
 * `refreshCampVerificationCache`, covering all 8 `VERIFIED_CAMP_FIELDS` PLUS
 * the `sessions-verified` Session rollup that `fieldSources` never had a slot
 * for. Re-deriving "verified" independently here would mean either (a)
 * reimplementing `deriveCampVerification`'s full Claim-ledger evaluation in
 * this test (already exercised end-to-end by
 * `tests/integration/verification-authority.test.ts`), or (b) resurrecting
 * the deleted `fieldSources`-only rule the task explicitly forbids. So this
 * test now seeds `Camp.dataConfidence` directly (known-by-construction —
 * upstream's method 1) and asserts the metric's SQL reads that column
 * correctly, including the moderator-scoping and percent/zero-division math
 * upstream's suite covered. AC3's "matches an independent... query" is now
 * satisfied by the SQL literally being `COUNT(*) FILTER (WHERE
 * dataConfidence = 'VERIFIED')` against known seed values, not by a second
 * derivation of the verification rule itself.
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`; `beforeAll` awaits `assertTestDatabase()`.
 * The module under test keeps using `@/lib/db`'s production pool, remapped to
 * the test database by `global-setup.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getVerifiedCoverageMetric } from "@/lib/admin/metrics-repository";
import type { DataConfidence } from "@/lib/types";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

interface Seed {
  slug: string;
  community: string;
  dataConfidence: DataConfidence;
}

const SEEDS: Seed[] = [
  { slug: "denver-full-1", community: "denver", dataConfidence: "VERIFIED" },
  { slug: "denver-full-2", community: "denver", dataConfidence: "VERIFIED" },
  // "Partial" here stands in for upstream's "8 of 9 fields attested" seed —
  // under the new model, anything short of a full Claim-ledger pass (fields
  // AND sessions-verified) lands on PLACEHOLDER (or STALE), never VERIFIED
  // (verification-policy.ts's `projectTrustStatusToDataConfidence`).
  { slug: "denver-partial", community: "denver", dataConfidence: "PLACEHOLDER" },
  { slug: "denver-none", community: "denver", dataConfidence: "PLACEHOLDER" },
  { slug: "boulder-full", community: "boulder", dataConfidence: "VERIFIED" },
];

async function seedCamps(): Promise<void> {
  const pool = getTestPool();
  for (const s of SEEDS) {
    await pool.query(
      `INSERT INTO "Camp" (id, slug, name, "campType", category, "communitySlug", "dataConfidence")
       VALUES ($1, $2, $3, 'SUMMER_DAY', 'SPORTS', $4, $5)`,
      [randomUUID(), s.slug, s.slug, s.community, s.dataConfidence],
    );
  }
}

/** Known-by-construction: how many seeds (in scope) are VERIFIED. */
function expectedVerified(scope?: string) {
  const inScope = SEEDS.filter((s) => !scope || s.community === scope);
  const verified = inScope.filter((s) => s.dataConfidence === "VERIFIED").length;
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
  it("site-wide count/% matches the known-by-construction seed data", async () => {
    await seedCamps();

    const metric = await getVerifiedCoverageMetric();
    const oracle = expectedVerified();

    // Known-by-construction: 3 of 5 VERIFIED → 60%.
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

  it("a non-VERIFIED dataConfidence (PLACEHOLDER or STALE) never counts as verified", async () => {
    await getTestPool().query(
      `INSERT INTO "Camp" (id, slug, name, "campType", category, "communitySlug", "dataConfidence")
       VALUES ($1, 'lonely-placeholder', 'lonely-placeholder', 'SUMMER_DAY', 'SPORTS', 'denver', 'PLACEHOLDER'),
              ($2, 'lonely-stale', 'lonely-stale', 'SUMMER_DAY', 'SPORTS', 'denver', 'STALE')`,
      [randomUUID(), randomUUID()],
    );
    const metric = await getVerifiedCoverageMetric();
    expect(metric).toEqual({ total: 2, verified: 0, pct: 0 });
  });

  it("returns zeroes (never divides by zero) on an empty catalog", async () => {
    expect(await getVerifiedCoverageMetric()).toEqual({
      total: 0,
      verified: 0,
      pct: 0,
    });
  });
});
