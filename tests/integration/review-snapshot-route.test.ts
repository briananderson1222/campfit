/**
 * tests/integration/review-snapshot-route.test.ts — AC2 route half
 * (`ac2-snapshot-drilldown`, campfit#91 Wave 1 Task 3 / R2) acceptance suite
 * for `GET /api/admin/review/[id]/snapshot`.
 *
 * Every REAL `CampChangeProposal` today has `snapshotRef: null` — the ref is
 * computed at multiple traverse pipeline layers but dropped before
 * persistence (see the route's file header + the review-provenance-
 * validation plan's R2 Stop-short risks). Wiring production population of
 * `snapshotRef` is an explicit fast-follow for the `lib/ingestion/**` lane,
 * out of scope here. So this suite proves the route against a FIXTURE that
 * is nonetheless REAL end-to-end: a `CampChangeProposal` row seeded with a
 * `snapshotRef` built from a genuine `buildSnapshotSourceRef(...)` call, and
 * a matching `Snapshot` `put()` into the REAL `createCampfitSnapshotStore()`
 * (the gitignored `.kontourai/campfit/snapshots/` filesystem store) — not a
 * mocked store. `@/lib/admin/access` is the only mocked import boundary,
 * same idiom as `tests/integration/onboard-url-outcomes.test.ts`.
 *
 * review-code.md M2 follow-up: the auth-ordering describe block below
 * exercises real per-community scoping via `evaluateAdminAccess` (not an
 * unconditional admin stub), following `camp-create.test.ts`'s
 * `requireAdminAccessMock.mockImplementation(...)` pattern — a moderator of
 * the proposal's OWN community 200s, a moderator of a DIFFERENT community
 * 403s with no `body`/`url` leaking into the response, and a real admin
 * 200s regardless of community.
 *
 * review-code.md M3 follow-up: a size-cap describe block proves the route
 * truncates an oversized `body` to `SNAPSHOT_BODY_MAX_CHARS` and reports
 * `truncated`/`totalLength` accurately, while an under-cap body round-trips
 * with `truncated: false` and `totalLength` equal to its own length.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSnapshotSourceRef } from '@kontourai/traverse/fetch';
import type { Snapshot } from '@kontourai/traverse/fetch';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';
import { SNAPSHOT_STORE_ROOT, createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';

// ── Import-boundary mock (requireAdminAccess needs a real Supabase session
// this suite does not have — same idiom as onboard-url-outcomes.test.ts).
// Hoisted + resettable (rather than an unconditionally-succeeding stub) so
// the auth-ordering describe block below can exercise REAL per-community
// scoping via the actual `evaluateAdminAccess`, following
// `camp-create.test.ts`'s `requireAdminAccessMock.mockImplementation(...)`
// pattern (review-code.md M2) ────────────────────────────────────────────
const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

import { evaluateAdminAccess } from '@/lib/admin/access';
import { GET } from '@/app/api/admin/review/[id]/snapshot/route';

const ADMIN_ACCESS = {
  access: {
    userId: 'admin-1',
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

function getRequest(id: string): Request {
  return new Request(`http://localhost/api/admin/review/${id}/snapshot`);
}

async function insertCamp(pool: Pool, communitySlug: string = 'denver'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories")
     VALUES ($1, $2, $3, $4, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'])
     RETURNING id`,
    [`Fixture Camp ${randomUUID()}`, `camp-${randomUUID()}`, 'https://fixture.example/camp', communitySlug],
  );
  return rows[0].id;
}

async function insertProposal(
  pool: Pool,
  campId: string,
  opts: { snapshotRef: string | null },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "sourceUrl", "snapshotRef")
     VALUES ($1, $2, $3) RETURNING id`,
    [campId, 'https://fixture.example/camp', opts.snapshotRef],
  );
  return rows[0].id;
}

function fixtureSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const body = overrides.body ?? '<html><body>Fixture snapshot body — real filesystem round trip.</body></html>';
  return {
    sourceId: 'https://fixture.example/camp',
    url: 'https://fixture.example/camp',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    status: 200,
    contentType: 'html',
    body,
    bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    ...overrides,
  };
}

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
});

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "CampChangeProposal", "Camp" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
  // Clean up the real (gitignored) filesystem snapshot store this suite
  // wrote fixtures into — harmless local scratch either way, but tidy.
  await rm(SNAPSHOT_STORE_ROOT, { recursive: true, force: true });
});

describe('GET /api/admin/review/[id]/snapshot (AC2 route half)', () => {
  it('(a) resolves a real fixture-seeded snapshotRef to its stored snapshot — 200 with the exact seeded body/url', async () => {
    const snapshot = fixtureSnapshot();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.snapshot.url).toBe(snapshot.url);
    expect(data.snapshot.body).toBe(snapshot.body);
    expect(data.snapshot.bodyHash).toBe(snapshot.bodyHash);
    expect(data.snapshot.fetchedAt).toBe(snapshot.fetchedAt);
    expect(data.snapshot.truncated).toBe(false);
    expect(data.snapshot.totalLength).toBe(snapshot.body.length);
  });

  it('(b) 404 no_snapshot_ref for a proposal whose snapshotRef is null (the honest default for every real proposal today)', async () => {
    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, { snapshotRef: null });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('no_snapshot_ref');
  });

  it('(c) 404 snapshot_not_found_in_store for a well-formed snapshotRef whose bodyHash was never put() into the store', async () => {
    // A valid-shaped ref (built the same real way) but its snapshot is
    // deliberately never `put()` — proves the route doesn't silently 200 on
    // a ref that can't actually be resolved.
    const neverStored = fixtureSnapshot({ body: 'this body was never persisted to the store' });
    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(neverStored),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('snapshot_not_found_in_store');
  });

  it('(d) 404 malformed_snapshot_ref for a snapshotRef that is not a parseable traverse-snapshot: ref', async () => {
    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, { snapshotRef: 'not-a-real-ref' });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('malformed_snapshot_ref');
  });
});

// ── review-code.md M2: auth-ordering / cross-community scoping ─────────────
// Follows camp-create.test.ts's `requireAdminAccessMock.mockImplementation`
// idiom rather than an unconditionally-succeeding stub, so these assertions
// exercise the REAL `evaluateAdminAccess` decision, not a mocked shortcut.
describe('GET /api/admin/review/[id]/snapshot — auth ordering (review-code.md M2)', () => {
  it('200s for a moderator scoped to the proposal\'s OWN community', async () => {
    const snapshot = fixtureSnapshot();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool, 'denver');
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });
    mockAsModerator('denver');

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.snapshot.url).toBe(snapshot.url);
  });

  it('403s for a moderator scoped to a DIFFERENT community, with no body/url leaking into the response', async () => {
    const snapshot = fixtureSnapshot();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool, 'boulder');
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });
    mockAsModerator('denver');

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Forbidden');
    expect(data).not.toHaveProperty('snapshot');
    expect(data.body).toBeUndefined();
    expect(data.url).toBeUndefined();
  });

  it('200s for a real admin regardless of the proposal\'s community', async () => {
    const snapshot = fixtureSnapshot();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool, 'boulder');
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });
    requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.snapshot.url).toBe(snapshot.url);
  });
});

// ── review-code.md M3: server-side body size cap ────────────────────────────
describe('GET /api/admin/review/[id]/snapshot — body size cap (review-code.md M3)', () => {
  it('truncates a body larger than the SNAPSHOT_BODY_MAX_CHARS cap and reports truncated/totalLength accurately', async () => {
    const oversizedBody = 'x'.repeat(500_000 + 12345);
    const snapshot = fixtureSnapshot({ body: oversizedBody });
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.snapshot.truncated).toBe(true);
    expect(data.snapshot.totalLength).toBe(oversizedBody.length);
    expect(data.snapshot.body.length).toBe(500_000);
    expect(data.snapshot.body).toBe(oversizedBody.slice(0, 500_000));
  });

  it('does not truncate a body at or under the cap', async () => {
    const exactBody = 'y'.repeat(500_000);
    const snapshot = fixtureSnapshot({ body: exactBody });
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.snapshot.truncated).toBe(false);
    expect(data.snapshot.totalLength).toBe(exactBody.length);
    expect(data.snapshot.body).toBe(exactBody);
  });
});
