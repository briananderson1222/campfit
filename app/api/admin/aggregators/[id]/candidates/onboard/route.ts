/**
 * app/api/admin/aggregators/[id]/candidates/onboard/route.ts — campfit#93
 * Wave 4, Task 4.1 (R4/AC4): `POST` onboards a multi-select batch of
 * `ProviderCandidate` ids through `onboardProviderCandidate` — campfit#90's
 * hardened `findProviderByDomain`/`createProvider` path, NOT
 * `approveProviderCandidate`'s own raw insert (see
 * `lib/ingestion/discovery/candidate-onboarding.ts`'s own header comment).
 *
 * Each candidate id is onboarded SEQUENTIALLY (not `Promise.all`) so one
 * candidate's failure (e.g. already onboarded, not found) does not abort the
 * rest of the batch — mirrors the per-source/per-page isolation discipline
 * used throughout this codebase's discovery/crawl code. Per-candidate
 * results are always `status: 'created' | 'existing' | 'error'`; the route
 * itself always returns 200 (the batch envelope carries partial failure,
 * not the HTTP status) unless the request itself is malformed.
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSourceCommunitySlug } from '@/lib/admin/community-access';
import {
  ensureAggregatorSourceSchema,
  getAggregatorSource,
} from '@/lib/ingestion/aggregator/aggregator-repository';
import { ensureProviderCandidateSchema } from '@/lib/ingestion/discovery/candidate-repository';
import { onboardProviderCandidate } from '@/lib/ingestion/discovery/candidate-onboarding';

interface OnboardResultRow {
  candidateId: string;
  status: 'created' | 'existing' | 'error';
  providerId?: string;
  providerSlug?: string;
  providerCreated?: boolean;
  error?: string;
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pool = getPool();
  await ensureAggregatorSourceSchema(pool);
  await ensureProviderCandidateSchema(pool);

  const communitySlug = await getAggregatorSourceCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const source = await getAggregatorSource(params.id, pool);
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const candidateIds: string[] = Array.isArray(body.candidateIds)
    ? body.candidateIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  if (candidateIds.length === 0) {
    return NextResponse.json({ error: 'candidateIds must be a non-empty array of strings' }, { status: 400 });
  }

  const results: OnboardResultRow[] = [];
  for (const candidateId of candidateIds) {
    try {
      const result = await onboardProviderCandidate(candidateId, { onboardedBy: auth.access.email }, pool);
      results.push({
        candidateId,
        status: result.providerCreated ? 'created' : 'existing',
        providerId: result.providerId,
        providerSlug: result.providerSlug,
        providerCreated: result.providerCreated,
      });
    } catch (err) {
      results.push({
        candidateId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ results });
}
