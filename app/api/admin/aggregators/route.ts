/**
 * app/api/admin/aggregators/route.ts — campfit#93 Wave 3, Task 3.2 (R1/AC1):
 * `POST` register a new `AggregatorSource`, `GET` list them scoped by
 * community.
 *
 * Auth follows `app/api/admin/providers/route.ts`'s own precedent exactly:
 * `requireAdminAccess({ communitySlug, allowModerator: true })` — a
 * moderator may register/view aggregators for their own community. The
 * ToS-decision action itself (a stricter, admin-only checkpoint) lives in
 * `[id]/tos-decision/route.ts`, not here.
 *
 * `GET` includes a `pendingCandidateCount` rollup per row (mirrors
 * `getProviders`'s `ProviderWithStats` convention) computed HERE, in the
 * route, rather than inside `listAggregatorSources` itself: that repository
 * function is landed, tested substrate
 * (`tests/integration/aggregator-source-schema.test.ts` calls it directly
 * without ever provisioning the separate `ProviderCandidate` table), so
 * folding a `LEFT JOIN "ProviderCandidate"` into its own SQL would make that
 * existing, already-passing test depend on a table it never provisions.
 * Both schemas are ensured idempotently here before querying either.
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { isValidHttpUrl } from '@/lib/admin/onboarding-validation';
import {
  createAggregatorSource,
  ensureAggregatorSourceSchema,
  listAggregatorSources,
} from '@/lib/ingestion/aggregator/aggregator-repository';
import { ensureProviderCandidateSchema } from '@/lib/ingestion/discovery/candidate-repository';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const community = searchParams.get('community')?.trim() || 'denver';

  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pool = getPool();
  await ensureAggregatorSourceSchema(pool);
  await ensureProviderCandidateSchema(pool);

  const sources = await listAggregatorSources(community, pool);
  const ids = sources.map((s) => s.id);

  const countRows = ids.length
    ? (
        await pool.query<{ aggregatorSourceId: string; count: string }>(
          `SELECT "aggregatorSourceId", COUNT(*)::text AS count
           FROM "ProviderCandidate"
           WHERE "aggregatorSourceId" = ANY($1::text[]) AND status = 'PENDING'
           GROUP BY "aggregatorSourceId"`,
          [ids],
        )
      ).rows
    : [];
  const countMap = new Map(countRows.map((r) => [r.aggregatorSourceId, Number(r.count)]));

  const withCounts = sources.map((source) => ({
    ...source,
    pendingCandidateCount: countMap.get(source.id) ?? 0,
  }));

  return NextResponse.json(withCounts);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const communitySlug = typeof body.communitySlug === 'string' && body.communitySlug.trim()
    ? body.communitySlug.trim()
    : 'denver';

  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url || !isValidHttpUrl(url)) {
    return NextResponse.json({ error: 'url must be a valid http(s) URL' }, { status: 400 });
  }

  const pool = getPool();
  await ensureAggregatorSourceSchema(pool);

  const maxPages = typeof body.maxPages === 'number' && Number.isFinite(body.maxPages)
    ? body.maxPages
    : undefined;
  const maxDepth = typeof body.maxDepth === 'number' && Number.isFinite(body.maxDepth)
    ? body.maxDepth
    : undefined;

  const source = await createAggregatorSource(
    { name, url, communitySlug, maxPages, maxDepth, createdBy: auth.access.email },
    pool,
  );
  return NextResponse.json(source, { status: 201 });
}
