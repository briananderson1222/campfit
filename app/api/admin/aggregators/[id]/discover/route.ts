/**
 * app/api/admin/aggregators/[id]/discover/route.ts — campfit#93 Wave 4,
 * Task 4.1 (R1/AC1's ROUTE-LEVEL half of the dual ToS gate, R2/AC2):
 * `POST` triggers `runAggregatorDiscovery` for one `AggregatorSource`.
 *
 * AC1's route-level gate: `canFetchAggregator(source)` is checked here and
 * returns `409` BEFORE `runAggregatorDiscovery` — and therefore before any
 * `crawlSource`/fetch call — is ever invoked. This is deliberately a
 * SEPARATE check from `runAggregatorDiscovery`'s own repository-level
 * re-check (`aggregator-extraction.ts`): the route never trusts that its own
 * check is sufficient (a `AggregatorTosNotApprovedError` thrown by the
 * function itself, e.g. from a race between this check and the call, is
 * still caught below and surfaced as the same 409 — defense-in-depth, not
 * the primary gate).
 *
 * `resolveExtractionProvider()` (the LIVE, non-CI datum-backed provider) is
 * resolved lazily, only on the approved path, after the 409 gate — mirrors
 * `runAggregatorDiscovery`'s own "never trust a stale check" discipline one
 * level up (no live provider resolution work happens on the unapproved
 * path either).
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSourceCommunitySlug } from '@/lib/admin/community-access';
import {
  canFetchAggregator,
  ensureAggregatorSourceSchema,
  getAggregatorSource,
} from '@/lib/ingestion/aggregator/aggregator-repository';
import {
  AggregatorSourceNotFoundError,
  AggregatorTosNotApprovedError,
  runAggregatorDiscovery,
} from '@/lib/ingestion/aggregator/aggregator-extraction';
import { ensureProviderCandidateSchema } from '@/lib/ingestion/discovery/candidate-repository';
import { resolveExtractionProvider } from '@/lib/ingestion/resolve-extraction-provider';

export const maxDuration = 300;

const TOS_REQUIRED_MESSAGE = 'ToS decision required before discovery can run';

export async function POST(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pool = getPool();
  await ensureAggregatorSourceSchema(pool);
  await ensureProviderCandidateSchema(pool);

  const communitySlug = await getAggregatorSourceCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const source = await getAggregatorSource(params.id, pool);
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Route-level half of AC1's dual gate — returns BEFORE runAggregatorDiscovery
  // (and therefore before any crawlSource/fetch call) is ever invoked.
  if (!canFetchAggregator(source)) {
    return NextResponse.json({ error: TOS_REQUIRED_MESSAGE }, { status: 409 });
  }

  try {
    const { provider } = resolveExtractionProvider();
    const summary = await runAggregatorDiscovery(
      params.id,
      { performedBy: auth.access.email },
      { provider },
      pool,
    );
    return NextResponse.json(summary);
  } catch (err) {
    if (err instanceof AggregatorTosNotApprovedError) {
      // Should be unreachable given the check above — defense-in-depth for
      // a race between this route's check and the call, not the primary
      // gate (that's the check above, proven with zero fetch calls).
      return NextResponse.json({ error: TOS_REQUIRED_MESSAGE }, { status: 409 });
    }
    if (err instanceof AggregatorSourceNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('[aggregators/discover] runAggregatorDiscovery failed:', err);
    return NextResponse.json({ error: 'Discovery failed' }, { status: 500 });
  }
}
