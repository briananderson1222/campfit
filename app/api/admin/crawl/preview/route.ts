import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { resolveCrawlCandidates, type CrawlCandidatePriority } from '@/lib/admin/crawl-priority';
import {
  countCrawlableCampsForCommunities,
  countCrawlableCampsForCommunity,
  getCrawlPreviewCampById,
  getCrawlPreviewCampsByIds,
  searchCrawlPreviewCamps,
  type CrawlPreviewCamp,
} from '@/lib/admin/crawl-repository';

export type { CrawlPreviewCamp } from '@/lib/admin/crawl-repository';

export type CrawlPriority = 'stale' | 'missing' | 'coming_soon' | 'never_crawled' | 'all' | 'specific';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const priority = (url.searchParams.get('priority') ?? 'stale') as CrawlPriority;
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
  const community = url.searchParams.get('community') ?? null;
  const auth = await requireAdminAccess({ communitySlug: community, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const campId = url.searchParams.get('campId') ?? null;
  const q = url.searchParams.get('q') ?? null;
  const scopedCommunities = auth.access.isAdmin ? null : auth.access.communities;

  // --- Batch lookup by IDs (for retry) ---
  const ids = url.searchParams.get('ids');
  if (ids) {
    const idList = ids.split(',').filter(Boolean);
    const camps = await getCrawlPreviewCampsByIds(idList, scopedCommunities);
    return NextResponse.json({ camps: camps as CrawlPreviewCamp[], totalCrawlable: camps.length });
  }

  // --- Single camp lookup by ID ---
  if (campId) {
    const camps = await getCrawlPreviewCampById(campId, scopedCommunities);
    const totalCrawlable = await countCrawlableCampsForCommunities(scopedCommunities);

    return NextResponse.json({
      camps: camps as CrawlPreviewCamp[],
      totalCrawlable,
    });
  }

  // --- Text search (priority=specific with q=<query>) ---
  if (priority === 'specific' && q) {
    const searchLimit = Math.min(limit, 10);
    const camps = await searchCrawlPreviewCamps(q, searchLimit, scopedCommunities);
    const totalCrawlable = await countCrawlableCampsForCommunities(scopedCommunities);

    return NextResponse.json({
      camps: camps as CrawlPreviewCamp[],
      totalCrawlable,
    });
  }

  // Base: priority-driven resolution (stale/missing/coming_soon/never_crawled/
  // all/specific-without-q — the latter behaves like 'all', matching
  // pre-extraction behavior where it fell through every priority-specific
  // branch below unmatched). Extracted to `resolveCrawlCandidates`
  // (lib/admin/crawl-priority.ts) — same SQL, same ordering, same output
  // shape as before this refactor; also called directly by the scheduled
  // cron route (campfit#92) so the two callers share one implementation.
  //
  // `community || scopedCommunities` (NOT `??`) deliberately reproduces the
  // pre-refactor `if (community) {...} else if (scopedCommunities) {...}`
  // truthy check (campfit#92 code review MEDIUM finding): `url.searchParams
  // .get('community')` returns `''` (not `null`) for an explicit
  // `?community=` with no value, which is falsy but not nullish — `??` would
  // pass that empty string straight through to the resolver's `typeof ===
  // 'string'` branch, matching zero camps instead of falling back to
  // `scopedCommunities` (no filter for an admin; the moderator's own scoped
  // communities otherwise) the way every other branch in this route already
  // does (see the `countResult` query two lines below, which was already
  // using the truthy `community ?` form pre-refactor and is unchanged here).
  const candidates = await resolveCrawlCandidates({
    priority: priority as CrawlCandidatePriority,
    limit,
    communitySlug: community || scopedCommunities,
  });

  // Total crawlable camps count
  const totalCrawlable = await countCrawlableCampsForCommunity(community, scopedCommunities);

  return NextResponse.json({
    camps: candidates as CrawlPreviewCamp[],
    totalCrawlable,
  });
}
