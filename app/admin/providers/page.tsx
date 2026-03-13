import { getProviders } from '@/lib/admin/provider-repository';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { ExternalLink, Building2 } from 'lucide-react';
import { requireAdminAccess } from '@/lib/admin/access';

export const dynamic = 'force-dynamic';

function relativeDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}yr ago`;
}

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

  const totalPending = providers.reduce((sum, p) => sum + (p.pendingProposals ?? 0), 0);

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

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="glass-panel p-5">
          <div className="flex items-center justify-between mb-2">
            <Building2 className="w-5 h-5 text-pine-500" />
            <span className="text-xs text-bark-300 uppercase tracking-wide">Total Providers</span>
          </div>
          <p className="font-display text-3xl font-extrabold text-bark-700">{providers.length}</p>
        </div>
        <div className={cn(
          'glass-panel p-5',
          totalPending > 0 && 'border-amber-300/60 bg-amber-50/30'
        )}>
          <div className="flex items-center justify-between mb-2">
            <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold',
              totalPending > 0 ? 'bg-amber-400 text-white' : 'bg-cream-300 text-bark-400'
            )}>!</span>
            <span className="text-xs text-bark-300 uppercase tracking-wide">Pending Proposals</span>
          </div>
          <p className="font-display text-3xl font-extrabold text-bark-700">{totalPending}</p>
        </div>
      </div>

      {/* Table */}
      {providers.length === 0 ? (
        <div className="glass-panel p-16 text-center">
          <p className="text-bark-300 text-lg">No providers yet</p>
          <p className="text-bark-200 text-sm mt-2">Add one manually above.</p>
        </div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cream-300/60 text-xs text-bark-300 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-semibold">Name</th>
                <th className="text-left px-4 py-3 font-semibold hidden md:table-cell">Domain</th>
                <th className="text-center px-4 py-3 font-semibold">Camps</th>
                <th className="text-center px-4 py-3 font-semibold">Pending</th>
                <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell">Last Crawled</th>
                <th className="text-right px-4 py-3 font-semibold hidden lg:table-cell">Avg Confidence</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider, i) => (
                <tr
                  key={provider.id}
                  className={cn(
                    'border-b border-cream-200/50 hover:bg-cream-100/60 transition-colors',
                    i % 2 === 0 ? 'bg-white/20' : 'bg-cream-50/30'
                  )}
                >
                  {/* Name */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/providers/${provider.id}`}
                      className="font-medium text-bark-700 hover:text-pine-600 transition-colors"
                    >
                      {provider.name}
                    </Link>
                    {provider.city && (
                      <p className="text-xs text-bark-300 mt-0.5">{provider.city}</p>
                    )}
                  </td>

                  {/* Domain */}
                  <td className="px-4 py-3 hidden md:table-cell">
                    {provider.domain ? (
                      <a
                        href={provider.websiteUrl ?? `https://${provider.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-bark-400 hover:text-pine-500 transition-colors text-xs"
                      >
                        {provider.domain}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-bark-200 text-xs">—</span>
                    )}
                  </td>

                  {/* Camps count */}
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-pine-100 text-pine-700 text-xs font-semibold min-w-[2rem]">
                      {provider.campCount ?? 0}
                    </span>
                  </td>

                  {/* Pending */}
                  <td className="px-4 py-3 text-center">
                    {(provider.pendingProposals ?? 0) > 0 ? (
                      <Link
                        href={`/admin/provider-review?providerId=${provider.id}`}
                        className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold hover:bg-amber-200 transition-colors min-w-[2rem]"
                      >
                        {provider.pendingProposals}
                      </Link>
                    ) : (
                      <span className="text-bark-200 text-xs">—</span>
                    )}
                  </td>

                  {/* Last crawled */}
                  <td className="px-4 py-3 text-xs text-bark-400 hidden sm:table-cell">
                    {relativeDate(provider.lastCrawledAt)}
                  </td>

                  {/* Avg confidence */}
                  <td className="px-4 py-3 text-right hidden lg:table-cell">
                    {provider.avgConfidence != null ? (
                      <span className={cn(
                        'text-xs font-semibold',
                        provider.avgConfidence >= 0.8 ? 'text-pine-600'
                          : provider.avgConfidence >= 0.5 ? 'text-amber-600'
                          : 'text-red-500'
                      )}>
                        {Math.round(provider.avgConfidence * 100)}%
                      </span>
                    ) : (
                      <span className="text-bark-200 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
