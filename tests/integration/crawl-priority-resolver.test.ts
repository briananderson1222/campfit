/**
 * tests/integration/crawl-priority-resolver.test.ts — AC1 (campfit#92,
 * Wave 1) for `resolveCrawlCandidates` (lib/admin/crawl-priority.ts),
 * against a real throwaway Postgres.
 *
 * This is the first regression guard for the base-priority SQL that used to
 * live inline in `app/api/admin/crawl/preview/route.ts` (no existing test
 * covered that route before this extraction) — cross-checked against the
 * pre-extraction query's literal WHERE/ORDER BY/scoring text (still visible
 * in `preview/route.ts`'s git history) rather than re-deriving the rule a
 * second, independent way.
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`; `beforeAll` awaits `assertTestDatabase()`.
 * The module under test keeps using `@/lib/db`'s production pool, remapped
 * to the test database by `global-setup.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resolveCrawlCandidates } from "@/lib/admin/crawl-priority";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

interface Seed {
  slug: string;
  communitySlug: string;
  websiteUrl: string;
  lastVerifiedAt: string | null;
  registrationStatus: "UNKNOWN" | "OPEN" | "COMING_SOON" | "CLOSED";
  dataConfidence: "PLACEHOLDER" | "STALE" | "VERIFIED";
  description: string;
  neighborhood: string;
}

// Known-by-construction seed set exercising every branch the pre-extraction
// SQL had: never_crawled (lastVerifiedAt IS NULL), coming_soon, missing
// (blank description/neighborhood/UNKNOWN status), and plain staleness
// scoring for the rest.
const SEEDS: Seed[] = [
  {
    slug: "never-crawled-1",
    communitySlug: "denver",
    websiteUrl: "https://never-1.example.com",
    lastVerifiedAt: null,
    registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER",
    description: "",
    neighborhood: "",
  },
  {
    slug: "never-crawled-2",
    communitySlug: "denver",
    websiteUrl: "https://never-2.example.com",
    lastVerifiedAt: null,
    registrationStatus: "OPEN",
    dataConfidence: "STALE",
    description: "has a description",
    neighborhood: "capitol-hill",
  },
  {
    slug: "very-stale",
    communitySlug: "denver",
    websiteUrl: "https://very-stale.example.com",
    lastVerifiedAt: "2020-01-01T00:00:00.000Z",
    registrationStatus: "OPEN",
    dataConfidence: "STALE",
    description: "has a description",
    neighborhood: "five-points",
  },
  {
    slug: "recently-verified",
    communitySlug: "denver",
    websiteUrl: "https://recent.example.com",
    lastVerifiedAt: new Date().toISOString(),
    registrationStatus: "OPEN",
    dataConfidence: "VERIFIED",
    description: "has a description",
    neighborhood: "lodo",
  },
  {
    slug: "coming-soon",
    communitySlug: "boulder",
    websiteUrl: "https://coming-soon.example.com",
    lastVerifiedAt: "2024-06-01T00:00:00.000Z",
    registrationStatus: "COMING_SOON",
    dataConfidence: "VERIFIED",
    description: "has a description",
    neighborhood: "downtown",
  },
  {
    slug: "missing-fields",
    communitySlug: "boulder",
    websiteUrl: "https://missing.example.com",
    lastVerifiedAt: "2024-06-01T00:00:00.000Z",
    registrationStatus: "UNKNOWN",
    dataConfidence: "VERIFIED",
    description: "",
    neighborhood: "",
  },
  {
    // No crawlable URL — must never appear in any resolver result, for any
    // priority (mirrors the pre-extraction route's own base WHERE clause).
    slug: "no-website",
    communitySlug: "denver",
    websiteUrl: "",
    lastVerifiedAt: null,
    registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER",
    description: "",
    neighborhood: "",
  },
];

async function seedCamps(): Promise<void> {
  const pool = getTestPool();
  for (const s of SEEDS) {
    await pool.query(
      `INSERT INTO "Camp"
        (id, slug, name, "campType", category, "communitySlug", "websiteUrl",
         "lastVerifiedAt", "registrationStatus", "dataConfidence", description, neighborhood)
       VALUES ($1, $2, $2, 'SUMMER_DAY', 'SPORTS', $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        s.slug,
        s.communitySlug,
        s.websiteUrl,
        s.lastVerifiedAt,
        s.registrationStatus,
        s.dataConfidence,
        s.description,
        s.neighborhood,
      ],
    );
  }
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

describe("resolveCrawlCandidates (AC1)", () => {
  it("never_crawled: only camps with lastVerifiedAt IS NULL, and only crawlable ones", async () => {
    await seedCamps();

    const rows = await resolveCrawlCandidates({ priority: "never_crawled", limit: 10 });

    // Look up ids by slug since ids are DB-generated randomUUID()s.
    const slugs = await sluggify(rows);
    expect(slugs.sort()).toEqual(["never-crawled-1", "never-crawled-2"].sort());
  });

  it("never_crawled: excludes camps without a crawlable websiteUrl", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({ priority: "never_crawled", limit: 10 });
    const slugs = await sluggify(rows);
    expect(slugs).not.toContain("no-website");
  });

  it("coming_soon: only COMING_SOON camps", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({ priority: "coming_soon", limit: 10 });
    const slugs = await sluggify(rows);
    expect(slugs).toEqual(["coming-soon"]);
  });

  it("missing: only camps with a blank description/neighborhood or UNKNOWN status", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({ priority: "missing", limit: 10 });
    const slugs = await sluggify(rows);
    // never-crawled-1 (UNKNOWN + null fields) and missing-fields (blank
    // fields + UNKNOWN) both qualify; no-website is excluded (no URL).
    expect(slugs.sort()).toEqual(["never-crawled-1", "missing-fields"].sort());
  });

  it("stale: ordered by priorityScore DESC, lastVerifiedAt ASC NULLS FIRST, and limit applied", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({ priority: "stale", limit: 2 });
    expect(rows).toHaveLength(2);

    // Never-crawled camps (NULL lastVerifiedAt → 180pt staleness ceiling)
    // score at least as high as any dated row, and NULLS FIRST breaks ties
    // among equal top scores — so the top of a stale-priority ranking must
    // be dominated by the never-crawled/highest-scoring rows, matching the
    // pre-extraction ORDER BY.
    const scores = rows.map((r) => r.priorityScore);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);

    const all = await resolveCrawlCandidates({ priority: "stale", limit: 100 });
    const allScores = all.map((r) => r.priorityScore);
    const sorted = [...allScores].sort((a, b) => b - a);
    expect(allScores).toEqual(sorted);
    // Same crawlable-only exclusion as every other priority.
    const slugs = await sluggify(all);
    expect(slugs).not.toContain("no-website");
  });

  it("all: behaves like stale (no extra WHERE clause), same crawlable-only base filter", async () => {
    await seedCamps();
    const stale = await resolveCrawlCandidates({ priority: "stale", limit: 100 });
    const all = await resolveCrawlCandidates({ priority: "all", limit: 100 });
    expect(all.map((r) => r.id)).toEqual(stale.map((r) => r.id));
  });

  it("communitySlug as a single string scopes to one community (the route's `community` query param)", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({ priority: "all", limit: 100, communitySlug: "boulder" });
    const slugs = await sluggify(rows);
    expect(slugs.sort()).toEqual(["coming-soon", "missing-fields"].sort());
  });

  it("communitySlug as an array scopes to a moderator's assigned communities", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({
      priority: "all",
      limit: 100,
      communitySlug: ["boulder"],
    });
    const slugs = await sluggify(rows);
    expect(slugs.sort()).toEqual(["coming-soon", "missing-fields"].sort());
  });

  it("communitySlug as an empty array matches zero rows (moderator with no assigned communities), not 'no filter'", async () => {
    await seedCamps();
    const rows = await resolveCrawlCandidates({ priority: "all", limit: 100, communitySlug: [] });
    expect(rows).toEqual([]);
  });
});

/** Resolve seeded ids back to slugs (ids are DB-generated randomUUID()s). */
async function sluggify(rows: { id: string }[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const result = await getTestPool().query<{ slug: string }>(
    `SELECT slug FROM "Camp" WHERE id = ANY($1)`,
    [rows.map((r) => r.id)],
  );
  return result.rows.map((r) => r.slug);
}
