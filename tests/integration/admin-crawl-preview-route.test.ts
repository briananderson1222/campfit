/**
 * tests/integration/admin-crawl-preview-route.test.ts — regression coverage
 * for campfit#92 code review's MEDIUM finding: `GET
 * /api/admin/crawl/preview`'s base-priority branch must reproduce the
 * pre-refactor truthy `if (community) {...} else if (scopedCommunities)
 * {...}` behavior for an explicit, empty-string `?community=` query param.
 *
 * `url.searchParams.get('community')` returns `''` (not `null`) when the
 * param is present with no value — falsy, but not nullish. Post-refactor,
 * the call site briefly used `community ?? scopedCommunities`, which only
 * falls through on `null`/`undefined`, so an explicit empty `community`
 * passed `''` straight to `resolveCrawlCandidates`, whose `typeof ===
 * 'string'` branch then filtered on `"communitySlug" = ''` — matching zero
 * camps instead of "no filter" (admin) or the moderator's own scoped
 * communities. Fixed at the call site (`community || scopedCommunities`);
 * this file proves the fix against the real resolver SQL, not just the
 * dispatch logic in isolation (`crawl-priority-resolver.test.ts`'s job is
 * the resolver's own branches; this file's job is the call site that feeds
 * it).
 *
 * Pattern: real `TEST_DATABASE_URL`, `requireAdminAccess` mocked at the
 * import boundary only (`admin-crawl-schedule-route.test.ts`'s established
 * shape) — the route's own SQL and `resolveCrawlCandidates` run for real.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

import { GET } from '@/app/api/admin/crawl/preview/route';

const ADMIN_ACCESS = {
  access: {
    userId: 'test-admin',
    email: 'admin@campfit.test',
    isAdmin: true,
    isModerator: false,
    communities: [] as string[],
  },
};

beforeAll(async () => {
  await assertTestDatabase();
});

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);
});

afterEach(async () => {
  await getTestPool().query(`TRUNCATE TABLE "Camp" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

async function seedCamp(communitySlug: string, slug: string): Promise<void> {
  await getTestPool().query(
    `INSERT INTO "Camp"
      (id, slug, name, "campType", category, "communitySlug", "websiteUrl",
       "lastVerifiedAt", "registrationStatus", "dataConfidence", description, neighborhood)
     VALUES ($1, $2, $2, 'SUMMER_DAY', 'SPORTS', $3, $4, NULL, 'UNKNOWN', 'PLACEHOLDER', '', '')`,
    [randomUUID(), slug, communitySlug, `https://${slug}.example.com`],
  );
}

describe('GET /api/admin/crawl/preview — community param semantics (campfit#92 code review MEDIUM)', () => {
  it('an explicit empty-string ?community= behaves identically to omitting the param (admin, no filter) — never zero-matches', async () => {
    await seedCamp('denver', 'denver-camp');
    await seedCamp('boulder', 'boulder-camp');

    const omittedRes = await GET(new Request('http://localhost/api/admin/crawl/preview?priority=all&limit=100'));
    const omittedData = await omittedRes.json();

    const explicitEmptyRes = await GET(
      new Request('http://localhost/api/admin/crawl/preview?priority=all&limit=100&community='),
    );
    const explicitEmptyData = await explicitEmptyRes.json();

    expect(explicitEmptyData.camps).toHaveLength(2);
    expect(explicitEmptyData.camps.map((c: { communitySlug: string }) => c.communitySlug).sort()).toEqual(
      ['boulder', 'denver'],
    );
    expect(explicitEmptyData.totalCrawlable).toBe(omittedData.totalCrawlable);
    expect(explicitEmptyData.camps.map((c: { id: string }) => c.id).sort()).toEqual(
      omittedData.camps.map((c: { id: string }) => c.id).sort(),
    );
  });

  it('a non-empty ?community= still scopes results to that one community (unaffected by the fix)', async () => {
    await seedCamp('denver', 'denver-camp');
    await seedCamp('boulder', 'boulder-camp');

    const res = await GET(
      new Request('http://localhost/api/admin/crawl/preview?priority=all&limit=100&community=denver'),
    );
    const data = await res.json();
    expect(data.camps).toHaveLength(1);
    expect(data.camps[0].communitySlug).toBe('denver');
  });
});
