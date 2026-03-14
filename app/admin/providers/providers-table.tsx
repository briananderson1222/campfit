'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Building2, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProviderWithStats } from '@/lib/types';

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

export function ProvidersTable({
  providers,
  archived,
}: {
  providers: ProviderWithStats[];
  archived: 'active' | 'archived';
}) {
  const [search, setSearch] = useState('');
  const [communityFilter, setCommunityFilter] = useState('ALL');
  const [pendingFilter, setPendingFilter] = useState<'ALL' | 'PENDING' | 'NO_PENDING'>('ALL');
  const [crawlFilter, setCrawlFilter] = useState<'ALL' | 'NEVER' | 'STALE'>('ALL');

  const communityOptions = useMemo(
    () => ['ALL', ...Array.from(new Set(providers.map((provider) => provider.communitySlug).filter(Boolean)))],
    [providers],
  );

  const filteredProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providers.filter((provider) => {
      const matchesSearch = !query
        || provider.name.toLowerCase().includes(query)
        || (provider.domain ?? '').toLowerCase().includes(query)
        || (provider.city ?? '').toLowerCase().includes(query)
        || provider.communitySlug.toLowerCase().includes(query);
      const matchesCommunity = communityFilter === 'ALL' || provider.communitySlug === communityFilter;
      const matchesPending = pendingFilter === 'ALL'
        || (pendingFilter === 'PENDING' && (provider.pendingProposals ?? 0) > 0)
        || (pendingFilter === 'NO_PENDING' && (provider.pendingProposals ?? 0) === 0);
      const lastCrawledDays = provider.lastCrawledAt
        ? Math.floor((Date.now() - new Date(provider.lastCrawledAt).getTime()) / 86_400_000)
        : null;
      const matchesCrawl = crawlFilter === 'ALL'
        || (crawlFilter === 'NEVER' && !provider.lastCrawledAt)
        || (crawlFilter === 'STALE' && (lastCrawledDays == null || lastCrawledDays >= 30));
      return matchesSearch && matchesCommunity && matchesPending && matchesCrawl;
    });
  }, [communityFilter, crawlFilter, pendingFilter, providers, search]);

  const totalPending = filteredProviders.reduce((sum, provider) => sum + (provider.pendingProposals ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="glass-panel p-5">
          <div className="mb-2 flex items-center justify-between">
            <Building2 className="h-5 w-5 text-pine-500" />
            <span className="text-xs uppercase tracking-wide text-bark-300">Visible Providers</span>
          </div>
          <p className="font-display text-3xl font-extrabold text-bark-700">{filteredProviders.length}</p>
        </div>
        <div className={cn('glass-panel p-5', totalPending > 0 && 'border-amber-300/60 bg-amber-50/30')}>
          <div className="mb-2 flex items-center justify-between">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold',
                totalPending > 0 ? 'bg-amber-400 text-white' : 'bg-cream-300 text-bark-400',
              )}
            >
              !
            </span>
            <span className="text-xs uppercase tracking-wide text-bark-300">Visible Pending Proposals</span>
          </div>
          <p className="font-display text-3xl font-extrabold text-bark-700">{totalPending}</p>
        </div>
      </div>

      <div className="glass-panel p-4 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Search</label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Provider, domain, city, or community"
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="w-full lg:w-44">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Community</label>
            <select
              value={communityFilter}
              onChange={(event) => setCommunityFilter(event.target.value)}
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            >
              {communityOptions.map((community) => (
                <option key={community} value={community}>
                  {community === 'ALL' ? 'All communities' : community}
                </option>
              ))}
            </select>
          </div>
          <div className="w-full lg:w-48">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Pending</label>
            <select
              value={pendingFilter}
              onChange={(event) => setPendingFilter(event.target.value as typeof pendingFilter)}
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            >
              <option value="ALL">All providers</option>
              <option value="PENDING">With pending proposals</option>
              <option value="NO_PENDING">No pending proposals</option>
            </select>
          </div>
          <div className="w-full lg:w-44">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Crawl Status</label>
            <select
              value={crawlFilter}
              onChange={(event) => setCrawlFilter(event.target.value as typeof crawlFilter)}
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            >
              <option value="ALL">All crawl states</option>
              <option value="NEVER">Never crawled</option>
              <option value="STALE">30+ days stale</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-bark-400">
          Showing {filteredProviders.length} of {providers.length} {archived} providers
        </p>
      </div>

      {filteredProviders.length === 0 ? (
        <div className="glass-panel p-16 text-center">
          <p className="text-lg text-bark-300">No providers match the current filters</p>
        </div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cream-300/60 text-xs uppercase tracking-wide text-bark-300">
                <th className="px-4 py-3 text-left font-semibold">Name</th>
                <th className="hidden px-4 py-3 text-left font-semibold md:table-cell">Domain</th>
                <th className="px-4 py-3 text-center font-semibold">Camps</th>
                <th className="px-4 py-3 text-center font-semibold">Pending</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Last Crawled</th>
                <th className="hidden px-4 py-3 text-right font-semibold lg:table-cell">Avg Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filteredProviders.map((provider, index) => (
                <tr
                  key={provider.id}
                  className={cn(
                    'border-b border-cream-200/50 transition-colors hover:bg-cream-100/60',
                    index % 2 === 0 ? 'bg-white/20' : 'bg-cream-50/30',
                  )}
                >
                  <td className="px-4 py-3">
                    <Link href={`/admin/providers/${provider.id}`} className="font-medium text-bark-700 transition-colors hover:text-pine-600">
                      {provider.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-bark-300">
                      {[provider.city, provider.communitySlug].filter(Boolean).join(' · ')}
                    </p>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    {provider.domain ? (
                      <a
                        href={provider.websiteUrl ?? `https://${provider.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-bark-400 transition-colors hover:text-pine-500"
                      >
                        {provider.domain}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-bark-200">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="inline-flex min-w-[2rem] items-center justify-center rounded-full bg-pine-100 px-2 py-0.5 text-xs font-semibold text-pine-700">
                      {provider.campCount ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {(provider.pendingProposals ?? 0) > 0 ? (
                      <Link
                        href={`/admin/provider-review?providerId=${provider.id}`}
                        className="inline-flex min-w-[2rem] items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-200"
                      >
                        {provider.pendingProposals}
                      </Link>
                    ) : (
                      <span className="text-xs text-bark-200">—</span>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-bark-400 sm:table-cell">{relativeDate(provider.lastCrawledAt)}</td>
                  <td className="hidden px-4 py-3 text-right lg:table-cell">
                    {provider.avgConfidence != null ? (
                      <span
                        className={cn(
                          'text-xs font-semibold',
                          provider.avgConfidence >= 0.8 ? 'text-pine-600'
                            : provider.avgConfidence >= 0.5 ? 'text-amber-600'
                            : 'text-red-500',
                        )}
                      >
                        {Math.round(provider.avgConfidence * 100)}%
                      </span>
                    ) : (
                      <span className="text-xs text-bark-200">—</span>
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
