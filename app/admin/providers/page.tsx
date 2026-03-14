import { getProviders } from '@/lib/admin/provider-repository';
import Link from 'next/link';
import { requireAdminAccess } from '@/lib/admin/access';
import { ProvidersTable } from './providers-table';

export const dynamic = 'force-dynamic';

export default async function AdminProvidersPage({
  searchParams,
}: {
  searchParams: { archived?: string };
}) {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;
  const archived = searchParams.archived === '1' ? 'archived' : 'active';
  const providers = await getProviders(
    auth.access.isAdmin ? 'denver' : auth.access.communities,
    archived,
  ).catch(() => []);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Providers</h1>
          <p className="text-bark-400 text-sm mt-1">
            {providers.length} provider{providers.length !== 1 ? 's' : ''} · camp organizations &amp; scraped sources
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={archived === 'archived' ? '/admin/providers' : '/admin/providers?archived=1'}
            className="btn-secondary text-sm"
          >
            {archived === 'archived' ? 'View Active' : 'View Archived'}
          </Link>
          {(auth.access.isAdmin || auth.access.communities.length === 1) && (
            <Link
              href="/admin/providers/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-pine-600 hover:bg-pine-700 text-cream-100 text-sm font-semibold rounded-xl transition-colors"
            >
              <span className="text-lg leading-none">+</span>
              New Provider
            </Link>
          )}
        </div>
      </div>

      <ProvidersTable providers={providers} archived={archived} />
    </div>
  );
}
