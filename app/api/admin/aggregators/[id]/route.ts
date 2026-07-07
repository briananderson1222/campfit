/**
 * app/api/admin/aggregators/[id]/route.ts — campfit#93 Wave 3, Task 3.2
 * (R1/AC1): `GET` detail for one `AggregatorSource`.
 *
 * Auth ordering mirrors `app/api/admin/providers/[providerId]/route.ts`
 * exactly: resolve the row's community scope FIRST
 * (`getAggregatorSourceCommunitySlug`) and run `requireAdminAccess` against
 * it BEFORE re-fetching the full row for the 404 check — so an
 * unauthenticated/unauthorized caller never learns whether a given id exists
 * (auth denial always wins over a 404).
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSourceCommunitySlug } from '@/lib/admin/community-access';
import {
  ensureAggregatorSourceSchema,
  getAggregatorSource,
} from '@/lib/ingestion/aggregator/aggregator-repository';

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pool = getPool();
  await ensureAggregatorSourceSchema(pool);

  const communitySlug = await getAggregatorSourceCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const source = await getAggregatorSource(params.id, pool);
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(source);
}
