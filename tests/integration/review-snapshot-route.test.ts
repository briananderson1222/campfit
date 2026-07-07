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
 */
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildSnapshotSourceRef } from '@kontourai/traverse/fetch';
import type { Snapshot } from '@kontourai/traverse/fetch';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';
import { SNAPSHOT_STORE_ROOT, createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';

// ── Import-boundary mock (requireAdminAccess needs a real Supabase session
// this suite does not have — same idiom as onboard-url-outcomes.test.ts) ──
vi.mock('@/lib/admin/access', () => ({
  requireAdminAccess: vi.fn(async () => ({
    access: {
      userId: 'admin-1',
      email: 'admin@campfit.test',
      isAdmin: true,
      isModerator: false,
      communities: ['denver'],
    },
  })),
}));

import { GET } from '@/app/api/admin/review/[id]/snapshot/route';

function getRequest(id: string): Request {
  return new Request(`http://localhost/api/admin/review/${id}/snapshot`);
}

async function insertCamp(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories")
     VALUES ($1, $2, $3, 'denver', 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'])
     RETURNING id`,
    [`Fixture Camp ${randomUUID()}`, `camp-${randomUUID()}`, 'https://fixture.example/camp'],
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

afterEach(async () => {
  await pool.query(`TRUNCATE "CampChangeProposal", "Camp" CASCADE`);
  vi.clearAllMocks();
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
