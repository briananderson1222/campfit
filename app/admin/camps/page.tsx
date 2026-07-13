import Link from 'next/link';
import { requireAdminAccess } from '@/lib/admin/access';
import { CampsTable } from './camps-table';
import { getAdminCampsWithQuality, type AdminCampRow } from '@/lib/admin/camp-repository';

export const dynamic = 'force-dynamic';

export default async function AdminCampsPage(
  props: {
    searchParams: Promise<{ archived?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;
  const archived = searchParams.archived === '1' ? 'archived' : 'active';
  const camps = await getAdminCampsWithQuality(
    archived,
    auth.access.isAdmin ? undefined : auth.access.communities,
  ).catch(() => [] as AdminCampRow[]);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-extrabold text-bark-700">Camp Data</h1>
            <p className="text-bark-400 text-sm mt-1">
              {camps.length} camps · sorted by missing fields then oldest verified · click Crawl to refresh a camp
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href={archived === 'archived' ? '/admin/camps' : '/admin/camps?archived=1'} className="btn-secondary text-sm">
              {archived === 'archived' ? 'View Active' : 'View Archived'}
            </Link>
            {/* Reaching this page already required admin or moderator-of-some-
                community access (see `requireAdminAccess` above); `/admin/camps/new`
                now scopes its own provider dropdown to the caller's communities
                (or all of them for admins) instead of hardcoding a single
                community, so it's safe to show this link regardless of how
                many communities the caller moderates. */}
            <Link
              href="/admin/camps/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-pine-600 hover:bg-pine-700 text-cream-100 text-sm font-semibold rounded-xl transition-colors"
            >
              <span className="text-lg leading-none">+</span>
              New Camp
            </Link>
          </div>
        </div>
      </div>

      <CampsTable camps={camps} archived={archived} />
    </div>
  );
}
