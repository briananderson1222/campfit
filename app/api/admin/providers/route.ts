import { NextResponse } from 'next/server';
import { getProviders, createProvider, findProviderByDomain } from '@/lib/admin/provider-repository';
import { requireAdminAccess } from '@/lib/admin/access';
import { isValidHttpUrl, parseDomain } from '@/lib/admin/onboarding-validation';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const community = searchParams.get('community') ?? 'denver';
  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const providers = await getProviders(community);
  return NextResponse.json(providers);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const communitySlug = typeof body.communitySlug === 'string' && body.communitySlug.trim()
    ? body.communitySlug.trim()
    : 'denver';
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  if (!isValidHttpUrl(body.websiteUrl)) {
    return NextResponse.json({ error: 'Website URL must be a valid http(s) URL' }, { status: 400 });
  }
  if (!isValidHttpUrl(body.crawlRootUrl)) {
    return NextResponse.json({ error: 'Crawl Root URL must be a valid http(s) URL' }, { status: 400 });
  }

  const domain = parseDomain(body.websiteUrl);
  if (domain) {
    const existing = await findProviderByDomain(domain);
    if (existing) {
      // The duplicate-domain block applies regardless of which community the
      // existing provider lives in (duplicates are global), but the *identity*
      // of the matched provider (id/name/slug) is only safe to return to a
      // requester who already has visibility into that provider's community —
      // otherwise a moderator scoped to their own community could use this
      // 409 to enumerate another community's providers. Admins can see any
      // community; moderators only the ones they're assigned to.
      const canSeeMatch = auth.access.isAdmin || auth.access.communities.includes(existing.communitySlug);
      if (canSeeMatch) {
        return NextResponse.json({
          error: 'A provider with this domain already exists',
          existingProviderId: existing.id,
          existingProviderName: existing.name,
          existingProviderSlug: existing.slug,
        }, { status: 409 });
      }
      return NextResponse.json({
        error: 'A provider with this domain already exists',
      }, { status: 409 });
    }
  }

  const provider = await createProvider({ ...body, communitySlug });
  return NextResponse.json(provider, { status: 201 });
}
