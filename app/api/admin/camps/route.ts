import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProviderCommunitySlug } from '@/lib/admin/community-access';
import { createCamp, CampCreateValidationError } from '@/lib/admin/camp-repository';
import { CAMP_TYPE_LABELS, CATEGORY_LABELS } from '@/lib/types';
import type { CampType, CampCategory } from '@/lib/types';

/**
 * POST /api/admin/camps — campfit#90 Wave 2 Task B / R3 / AC3. `providerId`
 * is required and must reference a real, non-archived provider so camp
 * create can never produce an orphan `Camp` row (see the plan's "Camp-create
 * bypassing provider linkage" stop-short risk). `websiteUrl` is validated
 * the same way as provider create (AC1). Auth/error shapes match the
 * existing `POST /api/admin/providers` route.
 *
 * Auth ordering: a naive `communitySlug = providerId ? await
 * getProviderCommunitySlug(providerId) : null` followed by a single
 * `requireAdminAccess({ communitySlug, allowModerator: true })` call would
 * let a moderator of *any* community pass the gate simply by submitting a
 * nonexistent/garbage `providerId` — `evaluateAdminAccess` treats a
 * null/falsy `requestedCommunity` as "any moderator of any single community
 * passes" (see `lib/admin/access.ts`). That's an accepted, pre-existing
 * pattern for *lookup* routes where a 404 always follows (e.g.
 * `camps/[campId]/route.ts` PATCH), but for a *create* route we tighten it:
 * a baseline auth check (any authenticated admin/moderator) runs first, the
 * `providerId` must resolve to a real provider (400 otherwise) before any
 * community-scoped decision is made, and only then do we re-check auth
 * against the provider's *actual* community — so a moderator can never use
 * an invalid `providerId` to skip the community-scoping check that applies
 * once a real provider is in play.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';

  // Baseline gate: must be an authenticated admin, or a moderator of *some*
  // community. This alone must never be sufficient to create a camp under a
  // community the caller doesn't have access to — the scoped re-check below
  // enforces that once providerId is known to resolve to a real provider.
  const baselineAuth = await requireAdminAccess({ allowModerator: true });
  if ('error' in baselineAuth) return NextResponse.json({ error: baselineAuth.error }, { status: baselineAuth.status });

  if (!providerId) return NextResponse.json({ error: 'providerId is required' }, { status: 400 });

  const communitySlug = await getProviderCommunitySlug(providerId);
  if (!communitySlug) {
    return NextResponse.json({ error: 'providerId must reference an existing provider' }, { status: 400 });
  }

  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const campType = typeof body.campType === 'string' ? body.campType : '';
  if (!campType || !(campType in CAMP_TYPE_LABELS)) {
    return NextResponse.json({ error: 'campType is required and must be a valid camp type' }, { status: 400 });
  }

  const category = typeof body.category === 'string' ? body.category : '';
  if (!category || !(category in CATEGORY_LABELS)) {
    return NextResponse.json({ error: 'category is required and must be a valid category' }, { status: 400 });
  }

  const websiteUrl = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : '';

  try {
    const camp = await createCamp({
      name,
      providerId,
      campType: campType as CampType,
      category: category as CampCategory,
      websiteUrl: websiteUrl || null,
      city: typeof body.city === 'string' ? (body.city.trim() || null) : null,
      neighborhood: typeof body.neighborhood === 'string' ? (body.neighborhood.trim() || null) : null,
      address: typeof body.address === 'string' ? (body.address.trim() || null) : null,
    });
    return NextResponse.json(camp, { status: 201 });
  } catch (err) {
    if (err instanceof CampCreateValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
