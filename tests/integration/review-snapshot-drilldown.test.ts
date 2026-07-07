/**
 * tests/integration/review-snapshot-drilldown.test.ts — AC2 panel half
 * (`ac2-snapshot-drilldown`, campfit#91 Wave 2 Task 4 / R2) acceptance suite
 * for `components/admin/snapshot-drilldown.tsx`'s "View source snapshot"
 * affordance in `review-panel.tsx`'s Source sidebar block.
 *
 * Same environment constraint as Wave 1's `review-format-badge.test.ts`/
 * `review-provenance-marker.test.ts`: this repo's Vitest config runs in a
 * plain-Node `environment: "node"` with no jsdom/testing-library and no
 * `.test.tsx` glob, and `review-panel.tsx`'s top-level `ReviewPanel` calls
 * `next/navigation`'s `useRouter`, which throws outside a real App Router
 * tree. `SnapshotDrilldown` itself has no router dependency, so it (and its
 * exported `parseSnapshotResponse` helper — the exact function its click
 * handler calls after `fetch()` resolves) can be exercised directly:
 *
 *   1. `renderToStaticMarkup` proves (b) — nothing renders when
 *      `snapshotRef` is absent — and that the button renders (idle state
 *      markup) when `snapshotRef` is present.
 *   2. `parseSnapshotResponse` is exercised against a REAL `Response`
 *      produced by the actual `GET /api/admin/review/[id]/snapshot` route
 *      handler (same real-Postgres + real-filesystem-snapshot-store fixture
 *      idiom as `review-snapshot-route.test.ts`) — proving (a) end-to-end:
 *      the panel-side parsing of a real resolved response yields the
 *      fixture-seeded snapshot's exact `url`, not a mocked shape that could
 *      drift from the route's real contract.
 *
 * review-code.md M3 follow-up: `parseSnapshotResponse` is also exercised
 * against a real oversized-body round trip (proving `truncated`/
 * `totalLength` survive the panel's own parsing, not just the route's raw
 * JSON), and `formatSnapshotTruncationNotice` — the pure message-formatting
 * helper the panel renders — is unit-tested directly against both shapes.
 *
 * campfit#53 (spa-ingestion, AC3) follow-up: the same real-route round trip
 * is exercised for traverse's `Snapshot.rendered` marker — a rendered
 * snapshot resolves as `rendered: true` (badge shows), a plain-fetched one
 * resolves as `rendered: false` (badge absent) — plus a direct unit test of
 * `shouldShowRenderedBadge`, the pure predicate the panel's JSX defers to,
 * against every shape a real client response could carry. Both the true AND
 * false/absent cases are covered explicitly, per the plan's stop-short risk
 * that a badge which always/never renders would technically "add a badge"
 * while failing AC3's honesty requirement.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildSnapshotSourceRef } from '@kontourai/traverse/fetch';
import type { Snapshot } from '@kontourai/traverse/fetch';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';
import { SNAPSHOT_STORE_ROOT, createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';

// ── Import-boundary mock (requireAdminAccess needs a real Supabase session
// this suite does not have — same idiom as review-snapshot-route.test.ts).
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
import {
  SnapshotDrilldown,
  parseSnapshotResponse,
  formatSnapshotTruncationNotice,
  shouldShowRenderedBadge,
} from '@/components/admin/snapshot-drilldown';

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
  await rm(SNAPSHOT_STORE_ROOT, { recursive: true, force: true });
});

describe('SnapshotDrilldown (AC2 panel half, presence/absence)', () => {
  it('(b) renders nothing when proposal.snapshotRef is absent', () => {
    const html = renderToStaticMarkup(
      createElement(SnapshotDrilldown, { proposalId: 'proposal-1', snapshotRef: null }),
    );
    expect(html).toBe('');
  });

  it('renders the "View source snapshot" button (idle state) when snapshotRef is present', () => {
    const html = renderToStaticMarkup(
      createElement(SnapshotDrilldown, {
        proposalId: 'proposal-1',
        snapshotRef: 'traverse-snapshot:https://fixture.example/camp?sha256=deadbeef&fetchedAt=2026-01-01T00%3A00%3A00.000Z',
      }),
    );
    expect(html).toContain('View source snapshot');
    expect(html).not.toBe('');
  });
});

describe('parseSnapshotResponse (AC2 panel half, real route round trip)', () => {
  it('(a) resolves a real fixture-seeded snapshotRef to the exact seeded url/body via the real route', async () => {
    const snapshot = fixtureSnapshot();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    const state = await parseSnapshotResponse(res);

    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.snapshot.url).toBe(snapshot.url);
      expect(state.snapshot.body).toBe(snapshot.body);
      expect(state.snapshot.bodyHash).toBe(snapshot.bodyHash);
      expect(state.snapshot.fetchedAt).toBe(snapshot.fetchedAt);
      expect(state.snapshot.truncated).toBe(false);
      expect(state.snapshot.totalLength).toBe(snapshot.body.length);
      expect(formatSnapshotTruncationNotice(state.snapshot)).toBeNull();
    }
  });

  it('(M3) resolves an oversized snapshotRef as truncated, with totalLength preserved and a formatted notice', async () => {
    const oversizedBody = 'x'.repeat(500_000 + 42);
    const snapshot = fixtureSnapshot({ body: oversizedBody });
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    const state = await parseSnapshotResponse(res);

    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.snapshot.truncated).toBe(true);
      expect(state.snapshot.totalLength).toBe(oversizedBody.length);
      expect(state.snapshot.body.length).toBe(500_000);
      expect(formatSnapshotTruncationNotice(state.snapshot)).toBe(
        `Truncated (showing 500,000 of ${oversizedBody.length.toLocaleString('en-US')} characters)`,
      );
    }
  });

  it('surfaces the route\'s error message for a proposal with no snapshotRef (honest default for every real proposal today)', async () => {
    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, { snapshotRef: null });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    const state = await parseSnapshotResponse(res);

    expect(state.status).toBe('error');
    if (state.status === 'error') {
      expect(state.message).toBe('no_snapshot_ref');
    }
  });
});

describe('Snapshot.rendered / the "Rendered" badge (campfit#53 spa-ingestion, AC3)', () => {
  it('a snapshot captured via the render seam (Snapshot.rendered: true) round-trips as rendered: true through the real route', async () => {
    const snapshot = fixtureSnapshot({ rendered: true });
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    const state = await parseSnapshotResponse(res);

    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.snapshot.rendered).toBe(true);
      expect(shouldShowRenderedBadge(state.snapshot)).toBe(true);
    }
  });

  it('a plain-fetched snapshot (no Snapshot.rendered field) round-trips as rendered: false, and the badge does not show', async () => {
    const snapshot = fixtureSnapshot();
    expect(snapshot.rendered).toBeUndefined();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);

    const campId = await insertCamp(pool);
    const proposalId = await insertProposal(pool, campId, {
      snapshotRef: buildSnapshotSourceRef(snapshot),
    });

    const res = await GET(getRequest(proposalId), { params: Promise.resolve({ id: proposalId }) });
    const state = await parseSnapshotResponse(res);

    expect(state.status).toBe('loaded');
    if (state.status === 'loaded') {
      expect(state.snapshot.rendered).toBe(false);
      expect(shouldShowRenderedBadge(state.snapshot)).toBe(false);
    }
  });

  it('shouldShowRenderedBadge is false for every absent/false shape a real client could receive (never a false positive)', () => {
    expect(shouldShowRenderedBadge({ url: 'https://x', fetchedAt: '2026-01-01', bodyHash: 'h', body: '', truncated: false, totalLength: 0 })).toBe(false);
    expect(shouldShowRenderedBadge({ url: 'https://x', fetchedAt: '2026-01-01', bodyHash: 'h', body: '', truncated: false, totalLength: 0, rendered: false })).toBe(false);
    expect(shouldShowRenderedBadge({ url: 'https://x', fetchedAt: '2026-01-01', bodyHash: 'h', body: '', truncated: false, totalLength: 0, rendered: true })).toBe(true);
  });
});
