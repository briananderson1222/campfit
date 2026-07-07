/**
 * tests/integration/camp-create.test.ts — campfit#90 Wave 2 Task B (R3/AC3)
 * acceptance suite for `lib/admin/camp-repository.ts`'s `createCamp` AND
 * `POST /api/admin/camps` (`app/api/admin/camps/route.ts`), against a real
 * throwaway Postgres (never a mocked `pg`), following
 * `provider-discovery.test.ts`'s `insertProvider` helper pattern and
 * `provider-create.test.ts`'s route-level `POST` + mocked-`requireAdminAccess`
 * pattern.
 *
 * Coverage:
 *   Repository (`createCamp`, direct calls):
 *   - a valid create links the new Camp to the given provider, sets
 *     dataConfidence: 'PLACEHOLDER', and single-value campTypes/categories
 *     arrays (matching onboard-url's existing convention).
 *   - slugs are made unique when two camps share a name, including when the
 *     first several candidate slugs are already taken (exercises the
 *     `INSERT ... ON CONFLICT (slug) DO NOTHING` retry loop's multi-attempt
 *     path, not just its first-conflict path — review finding: slug race).
 *   - camp create cannot bypass provider linkage: missing/garbage/archived
 *     providerId is rejected and creates no Camp row (the plan's stated
 *     stop-short risk).
 *   - an invalid websiteUrl is rejected, same as provider create (AC1).
 *
 *   Route (`POST`, real `Request` objects — review finding: the route itself
 *   had zero HTTP-level coverage):
 *   - 201 happy path through the route.
 *   - 400 for missing providerId/name, invalid campType/category.
 *   - `CampCreateValidationError` → 400 mapping (nonexistent/archived
 *     providerId reaching the repository layer).
 *   - auth-ordering (review finding: nonexistent providerId must not grant a
 *     global-moderator bypass of community scoping): a moderator of one
 *     community cannot create a camp under another community's (real)
 *     provider, and a nonexistent providerId is rejected with 400 before any
 *     community-scoped auth decision is made — verified via HTTP response
 *     shapes (401/403/201/400), not a mock-call spy; the repository layer's
 *     own providerId validation is an independent defense-in-depth backstop.
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`, and `beforeAll` awaits `assertTestDatabase()`
 * before anything destructive runs.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCamp, CampCreateValidationError } from '@/lib/admin/camp-repository';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

import { evaluateAdminAccess } from '@/lib/admin/access';
import { POST } from '@/app/api/admin/camps/route';

const ADMIN_ACCESS = {
  access: {
    userId: 'test-admin',
    email: 'admin@campfit.test',
    isAdmin: true,
    isModerator: false,
    communities: ['denver'],
  },
};

/** Simulates a real (non-admin) moderator via the actual `evaluateAdminAccess`. */
function mockAsModerator(communitySlug: string) {
  requireAdminAccessMock.mockImplementation(
    async (opts?: { communitySlug?: string | null; allowModerator?: boolean }) =>
      evaluateAdminAccess({
        userId: `mod-${communitySlug}`,
        email: `moderator@${communitySlug}.test`,
        isAdmin: false,
        assignments: [{ communitySlug, role: 'MODERATOR' }],
        requestedCommunity: opts?.communitySlug,
        allowModerator: opts?.allowModerator,
      }),
  );
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/camps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertProvider(
  pool: Pool,
  input: { name: string; communitySlug?: string; archived?: boolean },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Provider" (name, slug, "communitySlug", "archivedAt")
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      input.name,
      `prov-${randomUUID()}`,
      input.communitySlug ?? 'denver',
      input.archived ? new Date() : null,
    ],
  );
  return rows[0].id;
}

async function campCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "Camp"`);
  return Number(rows[0].count);
}

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
});

afterEach(async () => {
  await pool.query(`TRUNCATE "Camp", "Provider" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);
});

describe('createCamp — valid create', () => {
  it('links the new camp to the given provider, sets PLACEHOLDER confidence, and single-value type/category arrays', async () => {
    const providerId = await insertProvider(pool, { name: 'Wash Park Rec Center', communitySlug: 'denver' });

    const camp = await createCamp({
      name: 'Summer Adventure Camp',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
      websiteUrl: 'https://example.com/camps/summer-adventure',
    });

    expect(camp.providerId).toBe(providerId);
    expect(camp.dataConfidence).toBe('PLACEHOLDER');
    expect(camp.campType).toBe('SUMMER_DAY');
    expect(camp.category).toBe('SPORTS');
    expect(camp.campTypes).toEqual(['SUMMER_DAY']);
    expect(camp.categories).toEqual(['SPORTS']);
    expect(camp.communitySlug).toBe('denver');
    expect(camp.slug).toBeTruthy();

    const { rows } = await pool.query('SELECT id FROM "Camp" WHERE id = $1', [camp.id]);
    expect(rows.length).toBe(1);
  });

  it('generates a unique slug when two camps share a name', async () => {
    const providerId = await insertProvider(pool, { name: 'Foothills Park District' });

    const first = await createCamp({
      name: 'Nature Explorers',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'NATURE',
    });
    const second = await createCamp({
      name: 'Nature Explorers',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'NATURE',
    });

    expect(first.slug).not.toBe(second.slug);
  });

  // Review finding: slug-uniqueness check-then-insert race. `createCamp` now
  // does `INSERT ... ON CONFLICT (slug) DO NOTHING` + retry (matching
  // `onboard-url/route.ts`'s existing hardening) instead of a separate
  // `SELECT` pre-check, closing the TOCTOU window. Pre-seeding several
  // candidate slugs directly (bypassing `createCamp` entirely) forces the
  // very first `INSERT` attempt to hit `ON CONFLICT` and return no row —
  // exercising the retry loop's conflict branch itself, not just its
  // happy-path pre-check equivalent.
  it('retries past multiple pre-existing slug candidates via the INSERT ... ON CONFLICT retry loop', async () => {
    const providerId = await insertProvider(pool, { name: 'Slug Race Provider' });
    for (const slug of ['race-camp', 'race-camp-2', 'race-camp-3']) {
      await pool.query(
        `INSERT INTO "Camp" (name, slug, "communitySlug", "providerId", "campType", category, "campTypes", "categories", "dataConfidence")
         VALUES ($1, $2, 'denver', $3, 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY']::"CampType"[], ARRAY['OTHER']::"CampCategory"[], 'PLACEHOLDER')`,
        [`Race Camp placeholder (${slug})`, slug, providerId],
      );
    }

    const camp = await createCamp({
      name: 'Race Camp',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'OTHER',
    });

    expect(camp.slug).toBe('race-camp-4');
    expect(await campCount(pool)).toBe(4);
  });
});

describe('createCamp — provider linkage cannot be bypassed', () => {
  it('rejects a missing providerId and creates no row', async () => {
    await expect(
      createCamp({ name: 'Orphan Camp', providerId: '', campType: 'SUMMER_DAY', category: 'OTHER' }),
    ).rejects.toBeInstanceOf(CampCreateValidationError);
    expect(await campCount(pool)).toBe(0);
  });

  it('rejects a providerId that does not reference an existing provider', async () => {
    await expect(
      createCamp({
        name: 'Orphan Camp',
        providerId: randomUUID(),
        campType: 'SUMMER_DAY',
        category: 'OTHER',
      }),
    ).rejects.toBeInstanceOf(CampCreateValidationError);
    expect(await campCount(pool)).toBe(0);
  });

  it('rejects a providerId that references an archived provider', async () => {
    const providerId = await insertProvider(pool, { name: 'Archived Provider', archived: true });

    await expect(
      createCamp({ name: 'Orphan Camp', providerId, campType: 'SUMMER_DAY', category: 'OTHER' }),
    ).rejects.toBeInstanceOf(CampCreateValidationError);
    expect(await campCount(pool)).toBe(0);
  });
});

describe('createCamp — websiteUrl validation', () => {
  it('rejects an invalid websiteUrl and creates no row', async () => {
    const providerId = await insertProvider(pool, { name: 'Valid Provider' });

    await expect(
      createCamp({
        name: 'Bad URL Camp',
        providerId,
        campType: 'SUMMER_DAY',
        category: 'OTHER',
        websiteUrl: 'not a url',
      }),
    ).rejects.toBeInstanceOf(CampCreateValidationError);
    expect(await campCount(pool)).toBe(0);
  });

  it('accepts a missing/null websiteUrl (optional field)', async () => {
    const providerId = await insertProvider(pool, { name: 'Valid Provider 2' });

    const camp = await createCamp({
      name: 'No URL Camp',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'OTHER',
      websiteUrl: null,
    });
    expect(camp.id).toBeTruthy();
  });
});

// ── POST /api/admin/camps — route-level coverage (review finding: HIGH,
// zero HTTP-level test coverage for the route itself) ──────────────────────

describe('POST /api/admin/camps — happy path', () => {
  it('201s and creates a Camp linked to the given provider', async () => {
    const providerId = await insertProvider(pool, { name: 'Route Happy Path Provider' });

    const res = await POST(postRequest({
      name: 'Route Created Camp',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
      websiteUrl: 'https://example.com/route-camp',
    }));

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.providerId).toBe(providerId);
    expect(data.dataConfidence).toBe('PLACEHOLDER');
    expect(await campCount(pool)).toBe(1);
  });
});

describe('POST /api/admin/camps — 400s for missing/invalid required fields', () => {
  it('rejects a missing providerId with 400 and creates no row', async () => {
    const res = await POST(postRequest({
      name: 'No Provider Camp',
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/providerId is required/i);
    expect(await campCount(pool)).toBe(0);
  });

  it('rejects a missing name with 400 and creates no row', async () => {
    const providerId = await insertProvider(pool, { name: 'Provider For Missing Name' });

    const res = await POST(postRequest({
      providerId,
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/name is required/i);
    expect(await campCount(pool)).toBe(0);
  });

  it('rejects an invalid campType with 400 and creates no row', async () => {
    const providerId = await insertProvider(pool, { name: 'Provider For Bad CampType' });

    const res = await POST(postRequest({
      name: 'Bad CampType Camp',
      providerId,
      campType: 'NOT_A_REAL_TYPE',
      category: 'SPORTS',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/campType/i);
    expect(await campCount(pool)).toBe(0);
  });

  it('rejects an invalid category with 400 and creates no row', async () => {
    const providerId = await insertProvider(pool, { name: 'Provider For Bad Category' });

    const res = await POST(postRequest({
      name: 'Bad Category Camp',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'NOT_A_REAL_CATEGORY',
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/category/i);
    expect(await campCount(pool)).toBe(0);
  });
});

describe('POST /api/admin/camps — CampCreateValidationError -> 400 mapping', () => {
  it('maps an archived providerId (rejected by createCamp) to 400, not an uncaught 500', async () => {
    const providerId = await insertProvider(pool, { name: 'Archived Route Provider', archived: true });

    const res = await POST(postRequest({
      name: 'Should Not Be Created',
      providerId,
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/existing, non-archived provider/i);
    expect(await campCount(pool)).toBe(0);
  });
});

describe('POST /api/admin/camps — nonexistent providerId', () => {
  it('400s for a nonexistent providerId before ever reaching createCamp, and creates no row', async () => {
    const res = await POST(postRequest({
      name: 'Orphan Route Camp',
      providerId: randomUUID(),
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/providerId must reference an existing provider/i);
    expect(await campCount(pool)).toBe(0);
  });
});

describe('POST /api/admin/camps — auth ordering (review finding: nonexistent providerId must not bypass community scoping)', () => {
  it('rejects an unauthenticated/non-admin, non-moderator caller before any providerId is even considered', async () => {
    requireAdminAccessMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await POST(postRequest({
      name: 'Should Never Exist',
      providerId: randomUUID(),
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));

    expect(res.status).toBe(401);
    expect(await campCount(pool)).toBe(0);
  });

  it('a moderator of one community cannot create a camp under a real provider that belongs to a different community', async () => {
    const boulderProviderId = await insertProvider(pool, { name: 'Boulder Only Provider', communitySlug: 'boulder' });
    mockAsModerator('denver');

    const res = await POST(postRequest({
      name: 'Cross Community Camp',
      providerId: boulderProviderId,
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));

    expect(res.status).toBe(403);
    expect(await campCount(pool)).toBe(0);
  });

  it('a moderator of one community CAN create a camp under their own community\'s provider', async () => {
    const denverProviderId = await insertProvider(pool, { name: 'Denver Moderator Provider', communitySlug: 'denver' });
    mockAsModerator('denver');

    const res = await POST(postRequest({
      name: 'Same Community Camp',
      providerId: denverProviderId,
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));

    expect(res.status).toBe(201);
    expect(await campCount(pool)).toBe(1);
  });

  it('a nonexistent providerId is rejected with 400 for a moderator too, never granting a "no community" auth pass-through', async () => {
    mockAsModerator('denver');

    const res = await POST(postRequest({
      name: 'Bypass Attempt',
      providerId: randomUUID(),
      campType: 'SUMMER_DAY',
      category: 'SPORTS',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/providerId must reference an existing provider/i);
    expect(await campCount(pool)).toBe(0);
  });
});
