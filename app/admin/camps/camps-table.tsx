'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RecrawlButton } from './recrawl-button';
import { UrlEditor } from './url-editor';

interface CampRow {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  dataConfidence: string;
  lastVerifiedAt: string | null;
  communitySlug: string;
  registrationStatus: string;
  scheduleCount: number;
  missingFieldCount: number;
  pendingProposals: number;
}

export function CampsTable({
  camps,
  archived,
}: {
  camps: CampRow[];
  archived: 'active' | 'archived';
}) {
  const [search, setSearch] = useState('');
  const [communityFilter, setCommunityFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [qualityFilter, setQualityFilter] = useState<'ALL' | 'PENDING' | 'MISSING' | 'NEVER_VERIFIED'>('ALL');

  const communityOptions = useMemo(
    () => ['ALL', ...Array.from(new Set(camps.map((camp) => camp.communitySlug).filter(Boolean)))],
    [camps],
  );

  const filteredCamps = useMemo(() => {
    const query = search.trim().toLowerCase();
    return camps.filter((camp) => {
      const matchesSearch = !query
        || camp.name.toLowerCase().includes(query)
        || camp.slug.toLowerCase().includes(query)
        || camp.communitySlug.toLowerCase().includes(query);
      const matchesCommunity = communityFilter === 'ALL' || camp.communitySlug === communityFilter;
      const matchesStatus = statusFilter === 'ALL' || camp.registrationStatus === statusFilter;
      const matchesQuality = qualityFilter === 'ALL'
        || (qualityFilter === 'PENDING' && camp.pendingProposals > 0)
        || (qualityFilter === 'MISSING' && camp.missingFieldCount > 0)
        || (qualityFilter === 'NEVER_VERIFIED' && !camp.lastVerifiedAt);
      return matchesSearch && matchesCommunity && matchesStatus && matchesQuality;
    });
  }, [camps, communityFilter, qualityFilter, search, statusFilter]);

  return (
    <div className="space-y-4">
      <div className="glass-panel p-4 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Search</label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Camp name, slug, or community"
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
          <div className="w-full lg:w-44">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Status</label>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            >
              <option value="ALL">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="COMING_SOON">Coming Soon</option>
              <option value="UNKNOWN">Unknown</option>
            </select>
          </div>
          <div className="w-full lg:w-48">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Focus</label>
            <select
              value={qualityFilter}
              onChange={(event) => setQualityFilter(event.target.value as typeof qualityFilter)}
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            >
              <option value="ALL">All camps</option>
              <option value="PENDING">Pending proposals</option>
              <option value="MISSING">Missing fields</option>
              <option value="NEVER_VERIFIED">Never verified</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-bark-400">
          Showing {filteredCamps.length} of {camps.length} {archived} camps
        </p>
      </div>

      <div className="sm:hidden space-y-2">
        {filteredCamps.length === 0 ? (
          <p className="py-8 text-center text-sm text-bark-300">No camps match the current filters</p>
        ) : filteredCamps.map((camp) => (
          <div key={camp.id} className={cn('glass-panel p-4', !camp.websiteUrl && 'border-red-200/60 bg-red-50/20')}>
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link
                  href={`/admin/camps/${camp.id}`}
                  className="text-sm font-medium leading-snug text-bark-700 transition-colors hover:text-pine-600"
                >
                  {camp.name}
                </Link>
                <p className="mt-0.5 text-xs text-bark-300">{camp.communitySlug}</p>
              </div>
              {camp.websiteUrl && (
                <a
                  href={camp.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-bark-300 transition-colors hover:text-pine-500"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <StatusBadge value={camp.registrationStatus} />
              <ConfidenceBadge value={camp.dataConfidence} />
              {camp.pendingProposals > 0 && (
                <Link
                  href={`/admin/review?campId=${camp.id}`}
                  className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-200"
                >
                  {camp.pendingProposals} pending
                </Link>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-bark-400">
                <span>
                  {camp.lastVerifiedAt
                    ? new Date(camp.lastVerifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                    : <span className="font-medium text-red-400">Never verified</span>}
                </span>
                <span>{camp.scheduleCount > 0 ? `${camp.scheduleCount} wks` : <span className="text-red-400">0 wks</span>}</span>
                {camp.missingFieldCount > 0 && (
                  <span className={cn('font-medium', camp.missingFieldCount <= 2 ? 'text-amber-600' : 'text-red-500')}>
                    {camp.missingFieldCount} missing
                  </span>
                )}
              </div>
              {camp.websiteUrl
                ? <RecrawlButton campId={camp.id} campName={camp.name} />
                : <UrlEditor campId={camp.id} />}
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-hidden glass-panel sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-300/60 text-xs uppercase tracking-wide text-bark-300">
              <th className="px-4 py-3 text-left font-semibold">Camp</th>
              <th className="px-4 py-3 text-left font-semibold">Status</th>
              <th className="px-4 py-3 text-left font-semibold">Confidence</th>
              <th className="px-4 py-3 text-left font-semibold">Last Verified</th>
              <th className="px-4 py-3 text-center font-semibold">Weeks</th>
              <th className="px-4 py-3 text-center font-semibold">Missing</th>
              <th className="px-4 py-3 text-center font-semibold">Pending</th>
              <th className="px-4 py-3 text-left font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredCamps.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-bark-300">No camps match the current filters</td>
              </tr>
            ) : (
              filteredCamps.map((camp, index) => (
                <tr
                  key={camp.id}
                  className={cn(
                    'border-b border-cream-200/50 transition-colors hover:bg-cream-100/60',
                    !camp.websiteUrl ? 'bg-red-50/30' : index % 2 === 0 ? 'bg-white/20' : 'bg-cream-50/30',
                  )}
                >
                  <td className="px-4 py-3">
                    <Link href={`/admin/camps/${camp.id}`} className="font-medium text-bark-700 transition-colors hover:text-pine-600">
                      {camp.name}
                    </Link>
                    <p className="mt-0.5 text-xs text-bark-300">{camp.communitySlug}</p>
                  </td>
                  <td className="px-4 py-3"><StatusBadge value={camp.registrationStatus} /></td>
                  <td className="px-4 py-3"><ConfidenceBadge value={camp.dataConfidence} /></td>
                  <td className="px-4 py-3 text-xs text-bark-400">
                    {camp.lastVerifiedAt
                      ? new Date(camp.lastVerifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : <span className="font-medium text-red-400">Never</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-bark-400">
                    {camp.scheduleCount > 0 ? camp.scheduleCount : <span className="text-red-400">0</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cn(
                        'inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold',
                        camp.missingFieldCount === 0 ? 'bg-pine-100 text-pine-600'
                          : camp.missingFieldCount <= 2 ? 'bg-amber-100 text-amber-700'
                          : 'bg-red-100 text-red-600',
                      )}
                    >
                      {camp.missingFieldCount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {camp.pendingProposals > 0 ? (
                      <Link
                        href={`/admin/review?campId=${camp.id}`}
                        className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-200"
                      >
                        {camp.pendingProposals}
                      </Link>
                    ) : (
                      <span className="text-xs text-bark-200">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {camp.websiteUrl
                        ? <RecrawlButton campId={camp.id} campName={camp.name} />
                        : <UrlEditor campId={camp.id} />}
                      {camp.websiteUrl && (
                        <a
                          href={camp.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-bark-300 transition-colors hover:text-pine-500"
                          title={camp.websiteUrl}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const colors: Record<string, string> = {
    OPEN: 'bg-emerald-100 text-emerald-700',
    CLOSED: 'bg-red-100 text-red-600',
    COMING_SOON: 'bg-amber-100 text-amber-700',
    UNKNOWN: 'bg-gray-100 text-gray-500',
  };
  const labels: Record<string, string> = {
    OPEN: 'Open',
    CLOSED: 'Closed',
    COMING_SOON: 'Soon',
    UNKNOWN: '?',
  };
  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-semibold', colors[value] ?? 'bg-cream-200 text-bark-400')}>
      {labels[value] ?? value}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const colors: Record<string, string> = {
    VERIFIED: 'bg-pine-100 text-pine-700',
    HIGH: 'bg-emerald-100 text-emerald-700',
    MEDIUM: 'bg-amber-100 text-amber-700',
    LOW: 'bg-red-100 text-red-600',
    UNKNOWN: 'bg-gray-100 text-gray-500',
  };

  return (
    <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-semibold', colors[value] ?? 'bg-cream-200 text-bark-400')}>
      {value}
    </span>
  );
}
