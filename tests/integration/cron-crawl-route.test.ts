/**
 * tests/integration/cron-crawl-route.test.ts — AC1 (campfit#92, Wave 2)
 * acceptance evidence for `GET /api/cron/crawl`.
 *
 * Per `admin-scrape-route.test.ts`'s established pattern: import the route's
 * exported `GET` directly, call it with a real `Request`, and `vi.mock` only
 * import boundaries (`route.ts` source itself is never modified) —
 * `getSchedule`/`resolveCrawlCandidates`/`runCrawlPipeline` are all stubbed
 * so this file proves the ROUTE's own auth/no-op/wiring behavior, not the
 * real DB-backed schedule row (that's `crawl-schedule-repository.test.ts`'s
 * job) or the real priority SQL (that's `crawl-priority-resolver.test.ts`'s
 * job) or the real pipeline (already covered by the #85 seam's own tests).
 *
 * Also covers campfit#92 code review's two MEDIUM findings against this
 * route specifically:
 *  - the fail-closed/timing-safe `CRON_SECRET` check (`isAuthorizedCronRequest`
 *    in `route.ts`) — an unset secret and a wrong-length bearer token must
 *    both still be rejected with 401, never fall through to authenticated;
 *  - a `runCrawlPipeline` (or resolver) throw must degrade to an explicit
 *    500 response, never an unhandled rejection or a silently-swallowed
 *    `200 { ran: true }`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ── Import-boundary mocks (route.ts source untouched — only imports stubbed) ──

const getSchedule = vi.fn();
vi.mock('@/lib/admin/schedule-repository', () => ({
  getSchedule: (...args: unknown[]) => getSchedule(...args),
}));

const resolveCrawlCandidates = vi.fn();
vi.mock('@/lib/admin/crawl-priority', () => ({
  resolveCrawlCandidates: (...args: unknown[]) => resolveCrawlCandidates(...args),
}));

const runCrawlPipeline = vi.fn();
vi.mock('@/lib/ingestion/crawl-pipeline', () => ({
  runCrawlPipeline: (...args: unknown[]) => runCrawlPipeline(...args),
}));

import { GET } from '@/app/api/cron/crawl/route';

const CRON_SECRET = 'test-cron-secret';

function cronRequest(authorized = true): Request {
  return new Request('http://localhost/api/cron/crawl', {
    method: 'GET',
    headers: authorized ? { authorization: `Bearer ${CRON_SECRET}` } : {},
  });
}

beforeAll(() => {
  process.env.CRON_SECRET = CRON_SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cron/crawl', () => {
  it('rejects a request with no CRON_SECRET bearer token (401), before reading the schedule', async () => {
    const res = await GET(cronRequest(false));
    expect(res.status).toBe(401);
    expect(getSchedule).not.toHaveBeenCalled();
    expect(runCrawlPipeline).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong CRON_SECRET bearer token (401)', async () => {
    const res = await GET(
      new Request('http://localhost/api/cron/crawl', {
        headers: { authorization: 'Bearer not-the-secret' },
      })
    );
    expect(res.status).toBe(401);
    expect(getSchedule).not.toHaveBeenCalled();
  });

  it('no-ops with 200 when the schedule is disabled, and never calls the resolver or the pipeline', async () => {
    getSchedule.mockResolvedValue({
      id: 'default',
      enabled: false,
      priority: 'stale',
      batchSize: 5,
      updatedAt: '2026-07-06T00:00:00.000Z',
      updatedBy: null,
    });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ran: false, reason: 'disabled' });

    expect(resolveCrawlCandidates).not.toHaveBeenCalled();
    expect(runCrawlPipeline).not.toHaveBeenCalled();
  });

  it('when enabled, resolves candidates bounded to batchSize and calls runCrawlPipeline with trigger SCHEDULED', async () => {
    getSchedule.mockResolvedValue({
      id: 'default',
      enabled: true,
      priority: 'stale',
      batchSize: 5,
      updatedAt: '2026-07-06T00:00:00.000Z',
      updatedBy: null,
    });
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      id: `camp-${i}`,
      name: `Camp ${i}`,
      communitySlug: 'denver',
      websiteUrl: `https://camp-${i}.example.com`,
      dataConfidence: 'STALE',
      registrationStatus: 'UNKNOWN',
      lastVerifiedAt: null,
      missingFieldCount: 1,
      priorityScore: 100,
    }));
    resolveCrawlCandidates.mockResolvedValue(candidates);
    runCrawlPipeline.mockResolvedValue({
      id: 'run-scheduled-1',
      startedAt: '2026-07-06T09:00:00.000Z',
      completedAt: '2026-07-06T09:02:00.000Z',
      status: 'COMPLETED',
      totalCamps: 5,
      processedCamps: 5,
      errorCount: 0,
      newProposals: 3,
      trigger: 'SCHEDULED',
      triggeredBy: 'cron:scheduled-crawl',
      campIds: candidates.map((c) => c.id),
      errorLog: [],
      campLog: [],
    });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(resolveCrawlCandidates).toHaveBeenCalledTimes(1);
    expect(resolveCrawlCandidates).toHaveBeenCalledWith({ priority: 'stale', limit: 5 });

    expect(runCrawlPipeline).toHaveBeenCalledTimes(1);
    const [opts] = runCrawlPipeline.mock.calls[0];
    expect(opts.trigger).toBe('SCHEDULED');
    expect(opts.triggeredBy).toBe('cron:scheduled-crawl');
    expect(opts.campIds).toEqual(candidates.map((c) => c.id));
    expect(opts.campIds).toHaveLength(5);
    expect(opts.limit).toBe(5);

    expect(data).toEqual({
      ran: true,
      runId: 'run-scheduled-1',
      status: 'COMPLETED',
      processedCamps: 5,
      errorCount: 0,
      newProposals: 3,
    });
  });

  it('passes through the schedule\'s own priority/batchSize (never_crawled, batchSize 10) unchanged to the resolver', async () => {
    getSchedule.mockResolvedValue({
      id: 'default',
      enabled: true,
      priority: 'never_crawled',
      batchSize: 10,
      updatedAt: '2026-07-06T00:00:00.000Z',
      updatedBy: 'admin@example.test',
    });
    resolveCrawlCandidates.mockResolvedValue([]);
    runCrawlPipeline.mockResolvedValue({
      id: 'run-scheduled-2',
      startedAt: '2026-07-06T09:00:00.000Z',
      completedAt: '2026-07-06T09:00:05.000Z',
      status: 'COMPLETED',
      totalCamps: 0,
      processedCamps: 0,
      errorCount: 0,
      newProposals: 0,
      trigger: 'SCHEDULED',
      triggeredBy: 'cron:scheduled-crawl',
      campIds: [],
      errorLog: [],
      campLog: [],
    });

    await GET(cronRequest());

    expect(resolveCrawlCandidates).toHaveBeenCalledWith({ priority: 'never_crawled', limit: 10 });
    const [opts] = runCrawlPipeline.mock.calls[0];
    expect(opts.campIds).toEqual([]);
    expect(opts.limit).toBe(10);
  });

  it('degrades to an explicit 500 (never an unhandled rejection or a silent 200) when runCrawlPipeline rejects', async () => {
    getSchedule.mockResolvedValue({
      id: 'default',
      enabled: true,
      priority: 'stale',
      batchSize: 5,
      updatedAt: '2026-07-06T00:00:00.000Z',
      updatedBy: null,
    });
    resolveCrawlCandidates.mockResolvedValue([
      { id: 'camp-1', name: 'Camp 1', communitySlug: 'denver', websiteUrl: 'https://camp-1.example.com', dataConfidence: 'STALE', registrationStatus: 'UNKNOWN', lastVerifiedAt: null, missingFieldCount: 1, priorityScore: 100 },
    ]);
    runCrawlPipeline.mockRejectedValue(new Error('provider unavailable'));

    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('provider unavailable');
  });

  it('degrades to an explicit 500 when resolveCrawlCandidates itself rejects, never calling runCrawlPipeline with stale data', async () => {
    getSchedule.mockResolvedValue({
      id: 'default',
      enabled: true,
      priority: 'stale',
      batchSize: 5,
      updatedAt: '2026-07-06T00:00:00.000Z',
      updatedBy: null,
    });
    resolveCrawlCandidates.mockRejectedValue(new Error('db unreachable'));

    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('db unreachable');
    expect(runCrawlPipeline).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/crawl — CRON_SECRET fail-closed + timing-safe auth hardening (campfit#92 code review MEDIUM)', () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  it('rejects every request (never authenticates) when CRON_SECRET is unset, including the literal "Bearer undefined" a naive !== check would accept', async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(
      new Request('http://localhost/api/cron/crawl', {
        headers: { authorization: 'Bearer undefined' },
      })
    );
    expect(res.status).toBe(401);
    expect(getSchedule).not.toHaveBeenCalled();
  });

  it('rejects a same-content-different-length Authorization header (timingSafeEqual\'s length-guard path), never authenticating', async () => {
    process.env.CRON_SECRET = CRON_SECRET;

    const res = await GET(
      new Request('http://localhost/api/cron/crawl', {
        // Shorter than `Bearer ${CRON_SECRET}` — must be rejected before
        // any byte-compare, not just an accidental mismatch.
        headers: { authorization: 'Bearer short' },
      })
    );
    expect(res.status).toBe(401);
    expect(getSchedule).not.toHaveBeenCalled();
  });

  it('still authenticates the correct bearer token once CRON_SECRET is restored', async () => {
    process.env.CRON_SECRET = CRON_SECRET;
    getSchedule.mockResolvedValue({
      id: 'default',
      enabled: false,
      priority: 'stale',
      batchSize: 5,
      updatedAt: '2026-07-06T00:00:00.000Z',
      updatedBy: null,
    });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
  });
});
