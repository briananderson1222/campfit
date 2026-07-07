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
 *
 * Post-review fix (campfit#93 H1): the route's own `requireAdminAccess`
 * check only proves the requester may act on THIS aggregator
 * (`params.id`)/its community — it says nothing about which
 * `ProviderCandidate` rows the request body names. Every `candidateId` is
 * therefore looked up (`getCandidate`) and checked
 * `candidate.aggregatorSourceId === params.id` BEFORE
 * `onboardProviderCandidate` is ever called; a mismatch (or a candidate that
 * doesn't exist) comes back as a per-candidate `status: 'error'` result,
 * exactly like the pre-existing not-found handling, WITHOUT onboarding the
 * rest of the batch being aborted. `expectedAggregatorSourceId` is also
 * threaded into `onboardProviderCandidate` itself as a repository-level
 * defense-in-depth guard (see that function's own header comment) — the
 * same route-level + repository-level dual-layer discipline the ToS gate
 * (AC1) already uses.
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSourceCommunitySlug } from '@/lib/admin/community-access';
import {
  ensureAggregatorSourceSchema,
  getAggregatorSource,
} from '@/lib/ingestion/aggregator/aggregator-repository';
import { ensureProviderCandidateSchema, getCandidate } from '@/lib/ingestion/discovery/candidate-repository';
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
      // H1: verify the candidate actually belongs to THIS aggregator before
      // ever calling onboardProviderCandidate — the route's own auth check
      // only authorizes the requester against `params.id`'s community, not
      // against an arbitrary candidateId in the request body.
      const candidate = await getCandidate(candidateId, pool);
      if (!candidate) {
        throw new Error(`Candidate ${candidateId} not found`);
      }
      if (candidate.aggregatorSourceId !== params.id) {
        throw new Error(
          `Candidate ${candidateId} does not belong to aggregator ${params.id}; forbidden`,
        );
      }

      const result = await onboardProviderCandidate(
        candidateId,
        { onboardedBy: auth.access.email, expectedAggregatorSourceId: params.id },
        pool,
      );
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
