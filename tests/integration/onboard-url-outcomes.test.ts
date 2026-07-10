/**
 * tests/integration/onboard-url-outcomes.test.ts — R5/AC5 (campfit#90 Wave 2
 * Task C) acceptance suite for `POST /api/admin/crawl/onboard-url`'s
 * created/skipped breakdown.
 *
 * This route calls two `lib/ingestion/**` boundary functions
 * (`discoverCampsFromUrl`/`filterNewDiscoveries` from `llm-discovery`, and
 * `runCrawlPipeline` from `crawl-pipeline`) plus `requireAdminAccess`
 * (`lib/admin/access`) for a real Supabase session — none of which this
 * task's lane may touch or exercise for real (LLM discovery, a real fetch,
 * and a real logged-in session are all out of scope for a route test). Per
 * the plan's explicit note that no route-handler-via-HTTP or `vi.mock`
 * precedent exists yet in this repo, this file introduces the smallest
 * credible harness: import the route's exported `POST` directly, call it
 * with a real `Request`, and `vi.mock` only those three *import boundaries*
 * with deterministic stubs — `lib/ingestion/**` source is never modified,
 * only its import is swapped for this test file. Every `Provider`/`Camp`
 * assertion below goes through the real test DB via `getTestPool()`, per
 * `tests/integration/test-db.ts`'s safety contract.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

// ── Import-boundary mocks (lib/ingestion/** untouched — only the import is stubbed) ──

const discoverCampsFromUrl = vi.fn();
const ROUTE_FIXTURE_SNAPSHOT_REF = 'traverse-snapshot:campfit-discovery%3Ahttps%3A%2F%2Ffixture.example%2Fprograms?url=https%3A%2F%2Ffixture.example%2Fprograms&sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&fetchedAt=2026-07-10T00%3A00%3A00.000Z';

vi.mock('@/lib/ingestion/llm-discovery', () => ({
  discoverCampsFromUrl: (...args: unknown[]) => discoverCampsFromUrl(...args),
  buildDiscoveryFieldSources: (stub: { name: string }) => ({
    name: {
      excerpt: stub.name,
      locator: 'chars:0-10',
      sourceUrl: 'https://fixture.example/programs',
      sourceRef: ROUTE_FIXTURE_SNAPSHOT_REF,
    },
  }),
  // Deterministic stand-in for the real Dice-coefficient fuzzy matcher: a
  // stub is "new" iff its name isn't an exact (case-insensitive) match for
  // an existing camp name. Good enough to exercise the created/skipped
  // breakdown without depending on the real similarity threshold.
  filterNewDiscoveries: (stubs: { name: string }[], existingNames: string[]) =>
    stubs.filter((s) => !existingNames.some((n) => n.toLowerCase() === s.name.toLowerCase())),
}));

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => ({ provider: { name: 'route-test-provider' } }),
}));

vi.mock('@/lib/ingestion/traverse-snapshot-store', () => ({
  createCampfitSnapshotStore: () => ({}),
}));

vi.mock('@/lib/ingestion/crawl-pipeline', () => ({
  runCrawlPipeline: vi.fn(async (opts: { onProgress?: (event: unknown) => void }) => {
    opts.onProgress?.({ type: 'started', runId: 'test-run-id' });
    return { runId: 'test-run-id' };
  }),
}));

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

import { POST } from '@/app/api/admin/crawl/onboard-url/route';

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/admin/crawl/onboard-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertProvider(
  pool: Pool,
  input: { name: string; domain: string; communitySlug?: string },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Provider" (name, slug, domain, "communitySlug")
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.name, `prov-${randomUUID()}`, input.domain, input.communitySlug ?? 'denver'],
  );
  return rows[0].id;
}

async function insertCamp(
  pool: Pool,
  input: { name: string; websiteUrl: string; providerId: string; communitySlug?: string },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
     VALUES ($1, $2, $3, $4, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $5)
     RETURNING id`,
    [input.name, `camp-${randomUUID()}`, input.websiteUrl, input.communitySlug ?? 'denver', input.providerId],
  );
  return rows[0].id;
}

async function campCountForProvider(pool: Pool, providerId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "Camp" WHERE "providerId" = $1`,
    [providerId],
  );
  return Number(rows[0].count);
}

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
});

afterEach(async () => {
  await pool.query(`TRUNCATE "Camp", "Provider" CASCADE`);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeTestPool();
});

describe('POST /api/admin/crawl/onboard-url — created/skipped breakdown (R5/AC5)', () => {
  it('(a) brand-new domain with all-new programs: providerCreated true, created == discovered, no skips', async () => {
    discoverCampsFromUrl.mockResolvedValue({
      isListingPage: true,
      model: 'test',
      stubs: [
        { name: 'Camp Alpha', detailUrl: null, snippet: null },
        { name: 'Camp Beta', detailUrl: null, snippet: null },
      ],
    });

    const res = await POST(postRequest({ url: 'https://brand-new-domain.example/programs' }));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.runId).toBe('test-run-id');
    expect(data.providerCreated).toBe(true);
    expect(data.discovered).toBe(2);
    expect(data.created).toBe(2);
    expect(data.createdNames.sort()).toEqual(['Camp Alpha', 'Camp Beta']);
    expect(data.skipped).toBe(0);
    expect(data.skippedNames).toEqual([]);

    const { rows: providerRows } = await pool.query(
      `SELECT id FROM "Provider" WHERE domain = 'brand-new-domain.example'`,
    );
    expect(providerRows).toHaveLength(1);
    expect(await campCountForProvider(pool, providerRows[0].id)).toBe(2);
    const { rows: evidenceRows } = await pool.query<{ dataConfidence: string; fieldSources: Record<string, Record<string, unknown>> }>(
      `SELECT "dataConfidence", "fieldSources" FROM "Camp" WHERE "providerId" = $1 ORDER BY name`,
      [providerRows[0].id],
    );
    expect(evidenceRows).toHaveLength(2);
    for (const row of evidenceRows) {
      expect(row.dataConfidence).toBe('PLACEHOLDER');
      expect(row.fieldSources.name).toMatchObject({
        locator: 'chars:0-10',
        sourceUrl: 'https://fixture.example/programs',
        sourceRef: ROUTE_FIXTURE_SNAPSHOT_REF,
      });
      expect(row.fieldSources.name.approvedAt).toBeUndefined();
    }
  });

  it('(b) existing domain with a mix of new and duplicate programs: providerCreated false, partial created/skipped breakdown', async () => {
    const providerId = await insertProvider(pool, {
      name: 'Existing Provider',
      domain: 'existing-domain.example',
    });
    await insertCamp(pool, {
      name: 'Camp Existing',
      websiteUrl: 'https://existing-domain.example/camp-existing',
      providerId,
    });

    discoverCampsFromUrl.mockResolvedValue({
      isListingPage: true,
      model: 'test',
      stubs: [
        { name: 'Camp Existing', detailUrl: null, snippet: null },
        { name: 'Camp New', detailUrl: null, snippet: null },
      ],
    });

    const res = await POST(postRequest({ url: 'https://existing-domain.example/programs' }));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.runId).toBe('test-run-id');
    expect(data.providerId).toBe(providerId);
    expect(data.providerCreated).toBe(false);
    expect(data.discovered).toBe(2);
    expect(data.created).toBe(1);
    expect(data.createdNames).toEqual(['Camp New']);
    expect(data.skipped).toBe(1);
    expect(data.skippedNames).toEqual(['Camp Existing']);

    // 1 pre-seeded + 1 newly created == 2.
    expect(await campCountForProvider(pool, providerId)).toBe(2);
  });

  it('(c) existing domain where every discovered program already exists: 200 (not 422), created:0, full skipped-names list, no crawl triggered', async () => {
    const providerId = await insertProvider(pool, {
      name: 'All Duplicate Provider',
      domain: 'dup-domain.example',
    });
    await insertCamp(pool, {
      name: 'Camp Existing',
      websiteUrl: 'https://dup-domain.example/camp-existing',
      providerId,
    });

    discoverCampsFromUrl.mockResolvedValue({
      isListingPage: true,
      model: 'test',
      stubs: [{ name: 'Camp Existing', detailUrl: null, snippet: null }],
    });

    const res = await POST(postRequest({ url: 'https://dup-domain.example/programs' }));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.error).toBeUndefined();
    expect(data.providerCreated).toBe(false);
    expect(data.discovered).toBe(1);
    expect(data.created).toBe(0);
    expect(data.createdNames).toEqual([]);
    expect(data.skipped).toBe(1);
    expect(data.skippedNames).toEqual(['Camp Existing']);
    // No crawl triggered for the all-duplicate case.
    expect(data.runId).toBeUndefined();

    // No new Camp row was inserted — still just the one pre-seeded row.
    expect(await campCountForProvider(pool, providerId)).toBe(1);
  });

  it('keeps genuine discovery failures on their existing 422 error branch, distinguishable from the all-duplicate 200 case', async () => {
    discoverCampsFromUrl.mockResolvedValue({
      isListingPage: false,
      model: 'test',
      stubs: [],
      error: 'Fetch failed: HTTP 404',
    });

    const res = await POST(postRequest({ url: 'https://unreachable-domain.example/programs' }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('Fetch failed: HTTP 404');
    expect(data.created).toBeUndefined();
  });
});
