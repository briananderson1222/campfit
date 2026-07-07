/**
 * tests/integration/crawl-pipeline-snapshot-ref-writeside.test.ts —
 * campfit#97 (snapshot-ref-writeside) Wave 2 acceptance evidence for AC1 +
 * AC2 together: a REAL, pipeline-created `CampChangeProposal` (via
 * `runCrawlPipeline({ sources: [...] })`'s source-sweep strategy) carries a
 * non-null, resolvable `snapshotRef`/`snapshotBodyHash`, and #91's REAL `GET
 * /api/admin/review/[id]/snapshot` route resolves that ref back to the
 * exact stored snapshot — proving the write side (this issue) and the read
 * side (#91) compose end-to-end, not just via a hand-inserted fixture row
 * (see `tests/integration/review-snapshot-route.test.ts`, which proves the
 * route in isolation against such a fixture).
 *
 * Mocking idiom mirrors `crawl-pipeline-sources-strategy.test.ts` exactly
 * (`@/lib/ingestion/resolve-extraction-provider` stubbed, no real network/API
 * key; `@/lib/ingestion/traverse-pipeline`'s `runTraversePipelineForSource`
 * stubbed so this file isolates the sink-wiring/createProposal seam from
 * traverse's own fetch/extract mechanics) — EXCEPT `@/lib/ingestion/
 * traverse-snapshot-store` is deliberately NOT mocked here (unlike that
 * file's `createCampfitSnapshotStore: () => ({})` stub): this suite needs a
 * real filesystem `Snapshot` `put()` into the real store so the route's own
 * `store.get(...)` lookup can genuinely resolve it (mirrors
 * `review-snapshot-route.test.ts`'s `fixtureSnapshot()` + `store.put()`
 * pattern). `crawl-pipeline.ts` itself is never mocked — the real
 * `createProposal`/sink-wiring code from Wave 1 actually runs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSnapshotSourceRef } from '@kontourai/traverse/fetch';
import type { Snapshot } from '@kontourai/traverse/fetch';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

// ── Import-boundary mocks (same idiom as crawl-pipeline-sources-strategy.test.ts) ──

vi.mock('@/lib/ingestion/resolve-extraction-provider', () => ({
  resolveExtractionProvider: () => ({
    provider: {
      name: 'stub-extraction-provider',
      extract: async () => ({ proposals: [], raw: { response: '{}', model: 'stub-extraction-provider' } }),
    },
    ref: 'stub-ref',
    datumProvider: 'stub',
    model: 'stub-extraction-provider',
    maxTokens: 2048,
  }),
}));

// NOTE: unlike crawl-pipeline-sources-strategy.test.ts, do NOT mock
// '@/lib/ingestion/traverse-snapshot-store' here — this suite needs the REAL
// createCampfitSnapshotStore() so the route's store.get() lookup can
// genuinely resolve the snapshot this test put() into it (Stop-short risk,
// plan Wave 2).

const runTraversePipelineForSource = vi.fn();

vi.mock('@/lib/ingestion/traverse-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/traverse-pipeline')>();
  return {
    ...actual,
    runTraversePipelineForSource: (...args: unknown[]) => runTraversePipelineForSource(...args),
  };
});

// requireAdminAccess needs a real Supabase session this suite does not have
// — same idiom as review-snapshot-route.test.ts / onboard-url-outcomes.test.ts.
const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { SNAPSHOT_STORE_ROOT, createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';
import type { IngestionSourceConfig } from '@/lib/ingestion/sources';
import type { TraverseProposalSink } from '@/lib/ingestion/traverse-pipeline';
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

function getRequest(id: string): Request {
  return new Request(`http://localhost/api/admin/review/${id}/snapshot`);
}

function fixtureSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const body = overrides.body ?? '<html><body>Real pipeline-created snapshot — write-side round trip (campfit#97).</body></html>';
  return {
    sourceId: 'https://writeside.example.test/succeeding',
    url: 'https://writeside.example.test/succeeding',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    status: 200,
    contentType: 'html',
    body,
    bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
    ...overrides,
  };
}

/**
 * Real-snapshot-carrying stub source result — same shape as
 * crawl-pipeline-sources-strategy.test.ts's `stubSourceResult` "succeeding"
 * branch, except `snapshotRef`/`snapshotBodyHash` (both the routed sink
 * call's `meta` AND the returned `TraversePipelineSourceResult`) are built
 * from a REAL `Snapshot` via the real `buildSnapshotSourceRef` — not a
 * fabricated string — so the ref genuinely resolves through the real store.
 */
function stubRealSnapshotSourceResult(snapshot: Snapshot, snapshotRef: string) {
  return (src: IngestionSourceConfig, deps: { sink: TraverseProposalSink }) =>
    (async () => {
      const proposalId = await deps.sink(
        {
          itemIndex: 0,
          itemName: `Real Snapshot Camp (${src.key})`,
          sourceUrl: src.url,
          proposedChanges: {
            name: { old: null, new: `Real Snapshot Camp (${src.key})`, confidence: 0.9, mode: 'populate' },
          },
          overallConfidence: 0.9,
          extractionModel: 'stub-extraction-provider',
          rawExtraction: { via: 'crawl-pipeline-snapshot-ref-writeside-stub' },
          warnings: [],
        },
        {
          sourceKey: src.key,
          sourceUrl: src.url,
          snapshotRef,
          snapshotBodyHash: snapshot.bodyHash,
        }
      );
      return {
        source: src.key,
        url: src.url,
        ok: true,
        itemCount: 1,
        routedProposalIds: [proposalId],
        routedFieldCount: 1,
        snapshotRef,
        snapshotBodyHash: snapshot.bodyHash,
        fetchError: null,
        extractionError: null,
        warnings: [],
        tokensUsed: 100,
        providerCalls: 1,
        model: 'stub-extraction-provider',
        latencyMs: 10,
      };
    })();
}

/**
 * Stub source result that routes ONE item through the real sink but with NO
 * snapshot captured (mirrors a fetch that succeeded well enough to extract
 * but never captured a snapshot — `result.snapshotRef`/`.snapshotBodyHash`
 * both `null` on the real `TraversePipelineSourceResult` shape). Proves the
 * null-stays-null honesty case: a REAL proposal row is created (unlike a
 * whole-source failure, which never reaches the sink at all), and its
 * `snapshotRef`/`snapshotBodyHash` columns stay `null` rather than a
 * fabricated value.
 */
function stubNoSnapshotSourceResult(src: IngestionSourceConfig, deps: { sink: TraverseProposalSink }) {
  return (async () => {
    const proposalId = await deps.sink(
      {
        itemIndex: 0,
        itemName: `No Snapshot Camp (${src.key})`,
        sourceUrl: src.url,
        proposedChanges: {
          name: { old: null, new: `No Snapshot Camp (${src.key})`, confidence: 0.9, mode: 'populate' },
        },
        overallConfidence: 0.9,
        extractionModel: 'stub-extraction-provider',
        rawExtraction: { via: 'crawl-pipeline-snapshot-ref-writeside-null-stub' },
        warnings: [],
      },
      { sourceKey: src.key, sourceUrl: src.url, snapshotRef: null, snapshotBodyHash: null }
    );
    return {
      source: src.key,
      url: src.url,
      ok: true,
      itemCount: 1,
      routedProposalIds: [proposalId],
      routedFieldCount: 1,
      snapshotRef: null,
      snapshotBodyHash: null,
      fetchError: null,
      extractionError: null,
      warnings: [],
      tokensUsed: 100,
      providerCalls: 1,
      model: 'stub-extraction-provider',
      latencyMs: 10,
    };
  })();
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
  await pool.query(`TRUNCATE "CrawlRun", "Camp", "CampChangeProposal" CASCADE`);
  runTraversePipelineForSource.mockReset();
});

afterAll(async () => {
  await closeTestPool();
  await rm(SNAPSHOT_STORE_ROOT, { recursive: true, force: true });
});

describe('runCrawlPipeline({ sources }) -> real snapshotRef/snapshotBodyHash -> real GET /api/admin/review/[id]/snapshot (campfit#97 AC1+AC2)', () => {
  it('AC1+AC2: a real pipeline-created proposal carries a non-null, resolvable snapshotRef/snapshotBodyHash that the real route resolves to the exact stored snapshot', async () => {
    const snapshot = fixtureSnapshot();
    const store = createCampfitSnapshotStore();
    await store.put(snapshot);
    const snapshotRef = buildSnapshotSourceRef(snapshot);

    runTraversePipelineForSource.mockImplementation(stubRealSnapshotSourceResult(snapshot, snapshotRef));

    const run = await runCrawlPipeline({
      triggeredBy: 'test:snapshot-ref-writeside',
      trigger: 'MANUAL',
      sources: [
        { key: 'succeeding-source', name: 'Succeeding Source', url: snapshot.url },
      ],
    });

    // AC1: the real proposal row this pipeline run created carries non-null,
    // matching snapshotRef/snapshotBodyHash columns — a direct SELECT, not a
    // re-derivation through the route.
    const { rows } = await pool.query<{ id: string; snapshotRef: string | null; snapshotBodyHash: string | null }>(
      `SELECT id, "snapshotRef", "snapshotBodyHash" FROM "CampChangeProposal" WHERE "crawlRunId" = $1`,
      [run.id]
    );
    expect(rows).toHaveLength(1);
    const proposal = rows[0];
    expect(proposal.snapshotRef).not.toBeNull();
    expect(proposal.snapshotBodyHash).not.toBeNull();
    expect(proposal.snapshotRef).toBe(snapshotRef);
    expect(proposal.snapshotBodyHash).toBe(snapshot.bodyHash);
    // The ref round-trips through parseSnapshotSourceRef (same parse the
    // route itself performs) — proves it's a genuine, well-formed ref, not
    // an opaque string that merely happens to be non-null.
    const { parseSnapshotSourceRef } = await import('@kontourai/traverse/fetch');
    const parsed = parseSnapshotSourceRef(proposal.snapshotRef!);
    expect(parsed).toBeDefined();
    expect(parsed!.bodyHash).toBe(snapshot.bodyHash);

    // AC2: the REAL route handler resolves this REAL (non-fixture) proposal
    // id to the exact stored snapshot body/url/bodyHash.
    const res = await GET(getRequest(proposal.id), { params: Promise.resolve({ id: proposal.id }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.snapshot.body).toBe(snapshot.body);
    expect(data.snapshot.url).toBe(snapshot.url);
    expect(data.snapshot.bodyHash).toBe(snapshot.bodyHash);
  });

  it('null-stays-null: a routed item whose fetch never captured a snapshot writes snapshotRef/snapshotBodyHash as null, not a fabricated value, and the real route honestly 404s no_snapshot_ref for it', async () => {
    runTraversePipelineForSource.mockImplementation(stubNoSnapshotSourceResult);

    const run = await runCrawlPipeline({
      triggeredBy: 'test:snapshot-ref-writeside-null',
      trigger: 'MANUAL',
      sources: [
        { key: 'no-snapshot-source', name: 'No Snapshot Source', url: 'https://writeside.example.test/no-snapshot' },
      ],
    });

    const { rows } = await pool.query<{ id: string; snapshotRef: string | null; snapshotBodyHash: string | null }>(
      `SELECT id, "snapshotRef", "snapshotBodyHash" FROM "CampChangeProposal" WHERE "crawlRunId" = $1`,
      [run.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshotRef).toBeNull();
    expect(rows[0].snapshotBodyHash).toBeNull();

    const res = await GET(getRequest(rows[0].id), { params: Promise.resolve({ id: rows[0].id }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('no_snapshot_ref');
  });
});
