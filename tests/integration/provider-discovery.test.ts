/**
 * tests/integration/provider-discovery.test.ts — I22 / #52 acceptance suite for
 * provider discovery, against a real throwaway Postgres (never a mocked pg).
 *
 * Coverage:
 *   AC1 — the curated Denver source excludes out-of-metro candidates.
 *   AC2 — dedupe: re-running discovery, and candidates matching an existing
 *         provider (by domain and by normalized name), produce no duplicate
 *         queue entries; near-matches are surfaced (not skipped, not merged).
 *   AC3 — approval gate: discovery creates NO Provider; only the explicit
 *         approve action creates one, at most once.
 *   AC4 — every queued candidate carries discovery provenance.
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through `./test-db`'s
 * `getTestPool()` (a pool built straight from TEST_DATABASE_URL), and
 * `beforeAll` awaits `assertTestDatabase()` before anything destructive runs.
 * The ProviderCandidate table is provisioned here via the same idempotent
 * `ensureProviderCandidateSchema()` the discovery CLI uses — the additive
 * migration 013 is intentionally not yet wired into scripts/test-db-reset.ts
 * (that file is being modified on feat/verification-authority; see the PR body).
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { denverRecCenterSource } from "@/lib/ingestion/discovery/sources/denver-rec-centers";
import { runDiscovery } from "@/lib/ingestion/discovery/runner";
import {
  approveProviderCandidate,
  CandidateNotPendingError,
  ensureProviderCandidateSchema,
  getPendingCandidates,
  rejectProviderCandidate,
} from "@/lib/ingestion/discovery/candidate-repository";
import type {
  DiscoverySource,
  DiscoverySourceResult,
  RawProviderCandidate,
} from "@/lib/ingestion/discovery/types";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

const REVIEWER = "reviewer@campfit.test";

/** An in-memory discovery source returning exactly the candidates given. */
function stubSource(
  candidates: RawProviderCandidate[],
  overrides: Partial<Pick<DiscoverySource, "key" | "label" | "communitySlug">> = {},
): DiscoverySource {
  return {
    key: overrides.key ?? "stub-source",
    label: overrides.label ?? "Stub Discovery Source",
    communitySlug: overrides.communitySlug ?? "denver",
    async discover(): Promise<DiscoverySourceResult> {
      return {
        candidates,
        discoveryQuery: "stub query v1",
        retrievedAt: new Date("2026-07-04T12:00:00.000Z"),
      };
    },
  };
}

async function insertProvider(
  pool: Pool,
  input: { name: string; domain: string | null; communitySlug?: string },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Provider" (name, slug, domain, "communitySlug")
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.name, `prov-${randomUUID()}`, input.domain, input.communitySlug ?? "denver"],
  );
  return rows[0].id;
}

async function providerCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "Provider"`);
  return Number(rows[0].count);
}

async function candidateCountByName(pool: Pool, name: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "ProviderCandidate" WHERE name = $1`,
    [name],
  );
  return Number(rows[0].count);
}

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

// ── AC1: Denver-metro boundary ───────────────────────────────────────────────

describe("AC1 — Denver-metro boundary", () => {
  it("excludes out-of-metro candidates from the curated Denver source", async () => {
    const summary = await runDiscovery(denverRecCenterSource, { pool });

    // The curated seed deliberately includes Fort Collins + Colorado Springs.
    expect(summary.excludedOutOfMetro).toBeGreaterThanOrEqual(2);
    expect(summary.enqueuedNew).toBeGreaterThan(0);

    const queued = await getPendingCandidates("denver", pool);
    const queuedCities = queued.map((c) => (c.city ?? "").toLowerCase());
    expect(queuedCities).not.toContain("fort collins");
    expect(queuedCities).not.toContain("colorado springs");

    const excluded = summary.outcomes.filter((o) => o.disposition === "excluded-out-of-metro");
    expect(excluded.map((o) => o.candidate.city)).toEqual(
      expect.arrayContaining(["Fort Collins", "Colorado Springs"]),
    );
  });
});

// ── AC2: dedupe ──────────────────────────────────────────────────────────────

describe("AC2 — dedupe", () => {
  it("re-running discovery produces no duplicate queue entries", async () => {
    const source = stubSource([
      { name: "Foothills Park & Recreation District", websiteUrl: "https://ifoothills.org", city: "Lakewood" },
      { name: "Apex Park and Recreation District", websiteUrl: "https://apexprd.org", city: "Arvada" },
    ]);

    const first = await runDiscovery(source, { pool });
    expect(first.enqueuedNew).toBe(2);
    expect(first.skippedDuplicate).toBe(0);

    const second = await runDiscovery(source, { pool });
    expect(second.enqueuedNew).toBe(0);
    expect(second.skippedDuplicate).toBe(2);

    expect(await candidateCountByName(pool, "Foothills Park & Recreation District")).toBe(1);
    expect(await candidateCountByName(pool, "Apex Park and Recreation District")).toBe(1);
  });

  it("skips a candidate matching an existing provider by website domain", async () => {
    await insertProvider(pool, { name: "Some Other Name Entirely", domain: "ssprd.org" });

    const summary = await runDiscovery(
      stubSource([
        { name: "South Suburban Parks and Recreation", websiteUrl: "https://www.ssprd.org/programs", city: "Centennial" },
      ]),
      { pool },
    );

    expect(summary.enqueuedNew).toBe(0);
    expect(summary.skippedDuplicate).toBe(1);
    expect(summary.outcomes[0].disposition).toBe("skipped-duplicate");
    expect(summary.outcomes[0].detail).toContain("ssprd.org");
    expect((await getPendingCandidates("denver", pool)).length).toBe(0);
  });

  it("skips a candidate matching an existing provider by normalized name", async () => {
    await insertProvider(pool, { name: "Foothills Park & Recreation District", domain: null });

    const summary = await runDiscovery(
      stubSource([
        // Different punctuation/spacing/domain, same normalized name.
        { name: "foothills   park and recreation district!", websiteUrl: "https://elsewhere.example", city: "Lakewood" },
      ]),
      { pool },
    );

    expect(summary.enqueuedNew).toBe(0);
    expect(summary.skippedDuplicate).toBe(1);
    expect(summary.outcomes[0].detail).toContain("same normalized name");
    expect((await getPendingCandidates("denver", pool)).length).toBe(0);
  });

  it("queues a near-duplicate of an existing provider with a possible-duplicate pointer", async () => {
    const providerId = await insertProvider(pool, {
      name: "Cityscape Adventure Camps",
      domain: "cityscape-existing.example",
    });

    const summary = await runDiscovery(
      stubSource([
        // High name similarity, different domain → surfaced, not skipped/merged.
        { name: "Cityscape Adventure Camp", websiteUrl: "https://cityscape-new.example", city: "Denver" },
      ]),
      { pool },
    );

    expect(summary.skippedDuplicate).toBe(0);
    expect(summary.enqueuedNearDuplicate).toBe(1);
    expect(summary.enqueuedNew).toBe(0);

    const queued = await getPendingCandidates("denver", pool);
    expect(queued.length).toBe(1);
    expect(queued[0].possibleDuplicateOfProviderId).toBe(providerId);
    expect(queued[0].possibleDuplicateOfName).toBe("Cityscape Adventure Camps");
    expect(queued[0].duplicateReason).toMatch(/similar/i);
  });

  it("catches an exact duplicate that appears twice within one source run", async () => {
    const summary = await runDiscovery(
      stubSource([
        { name: "Golden Community Center", websiteUrl: "https://golden.example", city: "Golden" },
        { name: "Golden Community Center", websiteUrl: "https://golden.example", city: "Golden" },
      ]),
      { pool },
    );

    expect(summary.enqueuedNew).toBe(1);
    expect(summary.skippedDuplicate).toBe(1);
    expect(await candidateCountByName(pool, "Golden Community Center")).toBe(1);
  });
});

// ── AC3: approval gate ───────────────────────────────────────────────────────

describe("AC3 — approval gate", () => {
  async function seedOneCandidate(): Promise<string> {
    await runDiscovery(
      stubSource([
        { name: "Wheat Ridge Recreation Center", websiteUrl: "https://wheatridge.example", city: "Wheat Ridge" },
      ]),
      { pool },
    );
    const queued = await getPendingCandidates("denver", pool);
    expect(queued.length).toBe(1);
    return queued[0].id;
  }

  it("discovery enqueues candidates but creates no Provider", async () => {
    expect(await providerCount(pool)).toBe(0);
    await seedOneCandidate();
    expect(await providerCount(pool)).toBe(0);
  });

  it("approveProviderCandidate creates exactly one Provider and marks the candidate APPROVED", async () => {
    const candidateId = await seedOneCandidate();

    const result = await approveProviderCandidate(candidateId, { approvedBy: REVIEWER }, pool);
    expect(result.providerId).toBeTruthy();

    expect(await providerCount(pool)).toBe(1);
    const { rows: providerRows } = await pool.query(
      `SELECT name, domain, "communitySlug" FROM "Provider" WHERE id = $1`,
      [result.providerId],
    );
    expect(providerRows[0].name).toBe("Wheat Ridge Recreation Center");
    expect(providerRows[0].domain).toBe("wheatridge.example");
    expect(providerRows[0].communitySlug).toBe("denver");

    const { rows: candRows } = await pool.query(
      `SELECT status, "approvedProviderId", "reviewedBy" FROM "ProviderCandidate" WHERE id = $1`,
      [candidateId],
    );
    expect(candRows[0].status).toBe("APPROVED");
    expect(candRows[0].approvedProviderId).toBe(result.providerId);
    expect(candRows[0].reviewedBy).toBe(REVIEWER);
  });

  it("refuses to approve the same candidate twice and creates no second Provider", async () => {
    const candidateId = await seedOneCandidate();
    await approveProviderCandidate(candidateId, { approvedBy: REVIEWER }, pool);

    await expect(
      approveProviderCandidate(candidateId, { approvedBy: REVIEWER }, pool),
    ).rejects.toBeInstanceOf(CandidateNotPendingError);

    expect(await providerCount(pool)).toBe(1);
  });

  it("rejectProviderCandidate never creates a Provider", async () => {
    const candidateId = await seedOneCandidate();
    await rejectProviderCandidate(candidateId, { reviewedBy: REVIEWER }, pool);

    expect(await providerCount(pool)).toBe(0);
    const { rows } = await pool.query(
      `SELECT status FROM "ProviderCandidate" WHERE id = $1`,
      [candidateId],
    );
    expect(rows[0].status).toBe("REJECTED");
  });
});

// ── AC4: provenance ──────────────────────────────────────────────────────────

describe("AC4 — provenance", () => {
  it("records source, query, and retrieval time on every queued candidate", async () => {
    const retrievedAt = new Date("2026-07-04T12:00:00.000Z");
    const source: DiscoverySource = {
      key: "denver-rec-centers",
      label: "Denver Metro Rec-Center / Municipal Program Seed",
      communitySlug: "denver",
      async discover() {
        return {
          candidates: [
            { name: "Littleton Family Recreation", websiteUrl: "https://littleton.example", city: "Littleton" },
          ],
          discoveryQuery: "curated Denver metro rec-center seed v1",
          retrievedAt,
        };
      },
    };

    await runDiscovery(source, { pool });
    const [candidate] = await getPendingCandidates("denver", pool);

    expect(candidate.sourceKey).toBe("denver-rec-centers");
    expect(candidate.sourceLabel).toBe("Denver Metro Rec-Center / Municipal Program Seed");
    expect(candidate.discoveryQuery).toBe("curated Denver metro rec-center seed v1");
    expect(new Date(candidate.retrievedAt).toISOString()).toBe(retrievedAt.toISOString());
  });
});
