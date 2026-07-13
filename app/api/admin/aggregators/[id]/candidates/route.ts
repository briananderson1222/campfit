/**
 * app/api/admin/aggregators/[id]/candidates/route.ts — campfit#93 Wave 4,
 * Task 4.1 (R3/AC3): `GET` the curation queue for one `AggregatorSource`.
 *
 * `?status=` defaults to `PENDING` (the review queue's natural default);
 * `APPROVED`/`REJECTED`/`ALL` are also accepted for the curation screen's
 * history views. An unrecognized value falls back to `PENDING` rather than
 * erroring, matching this codebase's general "unknown filter is treated as
 * the safe default" discipline for read-only list routes.
 */
import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSourceCommunitySlug } from '@/lib/admin/community-access';
import {
  ensureAggregatorSourceSchema,
  getAggregatorSource,
} from '@/lib/ingestion/aggregator/aggregator-repository';
import {
  ensureProviderCandidateSchema,
  getCandidatesForAggregator,
} from '@/lib/ingestion/discovery/candidate-repository';

const VALID_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'ALL']);

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await ensureAggregatorSourceSchema();
  await ensureProviderCandidateSchema();

  const communitySlug = await getAggregatorSourceCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const source = await getAggregatorSource(params.id);
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get('status') ?? 'PENDING').trim().toUpperCase();
  const status = (VALID_STATUSES.has(requested) ? requested : 'PENDING') as
    | 'PENDING'
    | 'APPROVED'
    | 'REJECTED'
    | 'ALL';

  const candidates = await getCandidatesForAggregator(params.id, status);
  return NextResponse.json(candidates);
}
