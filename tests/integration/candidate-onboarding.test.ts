/**
 * tests/integration/candidate-onboarding.test.ts — campfit#93 Wave 2 Task
 * 2.1 acceptance suite for `onboardProviderCandidate` (R4/AC4's hardened
 * onboarding path).
 *
 * Coverage:
 *   (a) no existing domain match -> creates a real Provider row via
 *       campfit#90's hardened path (slug generated, domain populated via
 *       `parseDomain`), `providerCreated: true`.
 *   (b) an existing domain match (a Provider with the same domain inserted
 *       AFTER the candidate was enqueued) -> returns the EXISTING provider,
 *       no duplicate row, `providerCreated: false`.
 *   (c) a second call against the same (now-APPROVED) candidate id throws
 *       `CandidateNotPendingError`.
 *   (d) structural assertion that exactly one `Provider` row exists after
 *       two same-domain onboards (never a raw second `INSERT INTO
 *       "Provider"` outside `createProvider`/the existing-match branch).
 *
 * Seeds a `ProviderCandidate` row directly via `enqueueCandidate` — no
 * `AggregatorSource` dependency, matching the plan's "seeding a
 * ProviderCandidate row directly" acceptance framing (onboarding is
 * candidate-shaped, not aggregator-shaped).
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`, and `beforeAll` awaits
 * `assertTestDatabase()` before anything destructive runs (see
 * `provider-discovery.test.ts` for the established precedent).
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CandidateNotPendingError,
  enqueueCandidate,
  ensureProviderCandidateSchema,
  getCandidate,
} from "@/lib/ingestion/discovery/candidate-repository";
import {
  CandidateAggregatorMismatchError,
  onboardProviderCandidate,
} from "@/lib/ingestion/discovery/candidate-onboarding";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

const ONBOARDED_BY = "moderator@campfit.test";

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
  await ensureProviderCandidateSchema(pool);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "ProviderCandidate", "Provider" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

async function providerCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "Provider"`);
  return Number(rows[0].count);
}

async function insertProvider(input: { name: string; domain: string | null }): Promise<{ id: string; slug: string }> {
  const { rows } = await pool.query<{ id: string; slug: string }>(
    `INSERT INTO "Provider" (name, slug, domain, "communitySlug")
     VALUES ($1, $2, $3, 'denver') RETURNING id, slug`,
    [input.name, `prov-${randomUUID()}`, input.domain],
  );
  return rows[0];
}

async function seedCandidate(overrides: {
  name?: string;
  websiteUrl?: string | null;
  aggregatorSourceId?: string | null;
} = {}) {
  return enqueueCandidate(
    {
      name: overrides.name ?? "Sunbeam Adventure Camp",
      websiteUrl: overrides.websiteUrl ?? "https://sunbeam-camp.example",
      city: "Denver",
      communitySlug: "denver",
      sourceKey: "aggregator:test-agg",
      sourceLabel: "Test Aggregator",
      discoveryQuery: "https://test-agg.example/directory",
      retrievedAt: new Date("2026-07-06T12:00:00.000Z"),
      aggregatorSourceId: overrides.aggregatorSourceId,
    },
    pool,
  );
}

describe("onboardProviderCandidate", () => {
  it("(a) creates a real Provider via the hardened path when no domain match exists", async () => {
    const candidate = await seedCandidate();

    const result = await onboardProviderCandidate(candidate.id, { onboardedBy: ONBOARDED_BY }, pool);

    expect(result.providerCreated).toBe(true);
    expect(result.providerId).toBeTruthy();
    expect(result.providerSlug).toBeTruthy();

    const { rows: providerRows } = await pool.query(
      `SELECT name, domain, slug, notes FROM "Provider" WHERE id = $1`,
      [result.providerId],
    );
    expect(providerRows.length).toBe(1);
    expect(providerRows[0].name).toBe("Sunbeam Adventure Camp");
    expect(providerRows[0].domain).toBe("sunbeam-camp.example");
    expect(providerRows[0].notes).toContain("Onboarded from aggregator candidate");
    expect(providerRows[0].notes).toContain("Sunbeam Adventure Camp");
    expect(providerRows[0].notes).toContain("Test Aggregator");

    const updated = await getCandidate(candidate.id, pool);
    expect(updated?.status).toBe("APPROVED");
    expect(updated?.approvedProviderId).toBe(result.providerId);
    expect(updated?.reviewedBy).toBe(ONBOARDED_BY);
  });

  it("(b) returns the EXISTING provider when a matching-domain Provider appeared after enqueue", async () => {
    const candidate = await seedCandidate({ websiteUrl: "https://already-onboarded.example/programs" });

    // Simulates a Provider with the same domain being created (e.g. via the
    // manual admin create route) AFTER the candidate was queued but BEFORE
    // it is onboarded.
    const existing = await insertProvider({ name: "Already Onboarded Camp", domain: "already-onboarded.example" });

    const result = await onboardProviderCandidate(candidate.id, { onboardedBy: ONBOARDED_BY }, pool);

    expect(result.providerCreated).toBe(false);
    expect(result.providerId).toBe(existing.id);
    expect(result.providerSlug).toBe(existing.slug);
    expect(await providerCount()).toBe(1);

    const updated = await getCandidate(candidate.id, pool);
    expect(updated?.status).toBe("APPROVED");
    expect(updated?.approvedProviderId).toBe(existing.id);
  });

  it("(c) throws CandidateNotPendingError on a second onboard of the same candidate", async () => {
    const candidate = await seedCandidate();
    await onboardProviderCandidate(candidate.id, { onboardedBy: ONBOARDED_BY }, pool);

    await expect(
      onboardProviderCandidate(candidate.id, { onboardedBy: ONBOARDED_BY }, pool),
    ).rejects.toBeInstanceOf(CandidateNotPendingError);

    // No second Provider was created by the rejected retry.
    expect(await providerCount()).toBe(1);
  });

  it("(d) exactly one Provider row exists after two same-domain candidates onboard", async () => {
    const first = await seedCandidate({ name: "Twin Peaks Camp A", websiteUrl: "https://twin-peaks.example/a" });
    const second = await seedCandidate({ name: "Twin Peaks Camp B", websiteUrl: "https://twin-peaks.example/b" });

    const firstResult = await onboardProviderCandidate(first.id, { onboardedBy: ONBOARDED_BY }, pool);
    expect(firstResult.providerCreated).toBe(true);

    const secondResult = await onboardProviderCandidate(second.id, { onboardedBy: ONBOARDED_BY }, pool);
    expect(secondResult.providerCreated).toBe(false);
    expect(secondResult.providerId).toBe(firstResult.providerId);

    expect(await providerCount()).toBe(1);
  });

  // H1 defense-in-depth: `expectedAggregatorSourceId` is the repository-level
  // half of campfit#93's authorization-boundary fix. The route
  // (app/api/admin/aggregators/[id]/candidates/onboard/route.ts) is the
  // primary enforcement layer and is exercised separately in
  // tests/integration/aggregator-discover-onboard-routes.test.ts's own "H1 —
  // cross-aggregator candidateId rejection" suite; these tests prove the
  // function itself refuses a mismatch even when called directly.
  describe("H1 defense-in-depth — expectedAggregatorSourceId guard", () => {
    it("(e) throws CandidateAggregatorMismatchError when expectedAggregatorSourceId does not match the candidate's own aggregatorSourceId, creating NO Provider row", async () => {
      const candidate = await seedCandidate({ aggregatorSourceId: "aggregator-a" });

      await expect(
        onboardProviderCandidate(
          candidate.id,
          { onboardedBy: ONBOARDED_BY, expectedAggregatorSourceId: "aggregator-b" },
          pool,
        ),
      ).rejects.toBeInstanceOf(CandidateAggregatorMismatchError);

      expect(await providerCount()).toBe(0);
      const reloaded = await getCandidate(candidate.id, pool);
      expect(reloaded?.status).toBe("PENDING");
      expect(reloaded?.approvedProviderId).toBeNull();
    });

    it("(f) succeeds when expectedAggregatorSourceId matches the candidate's own aggregatorSourceId", async () => {
      const candidate = await seedCandidate({ aggregatorSourceId: "aggregator-a" });

      const result = await onboardProviderCandidate(
        candidate.id,
        { onboardedBy: ONBOARDED_BY, expectedAggregatorSourceId: "aggregator-a" },
        pool,
      );

      expect(result.providerCreated).toBe(true);
      const reloaded = await getCandidate(candidate.id, pool);
      expect(reloaded?.status).toBe("APPROVED");
    });
  });

  // H2 — atomicity: `findProviderByDomain`/`createProvider`
  // (lib/admin/provider-repository.ts) now accept an additive `executor`
  // override so the Provider write joins THIS function's own candidate-row
  // transaction. Fault-injection note: `faultyPool` below is a thin wrapper
  // around the real test pool whose `.connect()` returns a client that
  // intercepts only the `INSERT INTO "Provider"` statement and rejects it —
  // every other statement (BEGIN/SELECT...FOR UPDATE/ROLLBACK) passes
  // through to the REAL connection untouched, so a real Postgres ROLLBACK is
  // what is actually being asserted on below, not a mocked one.
  describe("H2 atomicity — fault-injection", () => {
    it("(g) fault-injection: a createProvider failure mid-transaction rolls back fully — no orphaned Provider row, candidate stays PENDING", async () => {
      const candidate = await seedCandidate({
        name: "Fault Injection Camp",
        websiteUrl: "https://fault-injection.example",
      });

      const faultyPool = {
        connect: async () => {
          const client = await pool.connect();
          const originalQuery = client.query.bind(client);
          const originalRelease = client.release.bind(client);
          return {
            query: (...args: unknown[]) => {
              const text = typeof args[0] === "string" ? args[0] : undefined;
              if (text?.includes('INSERT INTO "Provider"')) {
                return Promise.reject(new Error("INJECTED createProvider failure (test fault injection)"));
              }
              return (originalQuery as (...a: unknown[]) => unknown)(...args);
            },
            release: (...args: unknown[]) => (originalRelease as (...a: unknown[]) => void)(...args),
          };
        },
      } as unknown as Pool;

      await expect(
        onboardProviderCandidate(candidate.id, { onboardedBy: ONBOARDED_BY }, faultyPool),
      ).rejects.toThrow("INJECTED createProvider failure");

      // Full rollback against the REAL connection: no orphaned Provider row...
      expect(await providerCount()).toBe(0);
      // ...and the candidate row rolled back to PENDING, not left mid-flight APPROVED.
      const reloaded = await getCandidate(candidate.id, pool);
      expect(reloaded?.status).toBe("PENDING");
      expect(reloaded?.approvedProviderId).toBeNull();
    });
  });
});
