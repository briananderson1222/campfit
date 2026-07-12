import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampIdsCommunitySlugs } from '@/lib/admin/community-access';
import { getCampNamesByIds, getLatestCrawlRunsForAdmin } from '@/lib/admin/crawl-repository';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const rawRuns = await getLatestCrawlRunsForAdmin();
  const runs = auth.access.isAdmin
    ? rawRuns
    : (await Promise.all(rawRuns.map(async (run: { campIds: string[] | null }) => {
        const communities = await getCampIdsCommunitySlugs(run.campIds ?? []);
        return communities.length > 0 && communities.every((community) => auth.access.communities.includes(community))
          ? run
          : null;
      }))).filter(Boolean);

  // Resolve campIds → camp names for targeted runs
  const allCampIds = Array.from(new Set(runs.flatMap((r: { campIds: string[] | null } | null) => r?.campIds ?? [])));
  const campNames: Record<string, string> = {};
  if (allCampIds.length > 0) {
    const camps = await getCampNamesByIds(allCampIds);
    camps.forEach((c) => { campNames[c.id] = c.name; });
  }

  return NextResponse.json({ runs, campNames });
}
