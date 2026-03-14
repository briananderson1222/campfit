import { requireAdminAccess } from '@/lib/admin/access';
import { getUncrawlableCamps } from '@/lib/admin/crawl-failure-repository';
import { CrawlFailuresTable } from './crawl-failures-table';

export const dynamic = 'force-dynamic';

export default async function CrawlFailuresPage() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;

  const rows = await getUncrawlableCamps({
    communitySlugs: auth.access.isAdmin ? undefined : auth.access.communities,
    limit: 250,
  }).catch(() => []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-bark-700">Uncrawlable Camps</h1>
        <p className="mt-1 text-sm text-bark-400">
          Camps with recent crawl failures that likely need manual data fixes, URL replacement, or archiving.
        </p>
      </div>

      <CrawlFailuresTable rows={rows} />
    </div>
  );
}
