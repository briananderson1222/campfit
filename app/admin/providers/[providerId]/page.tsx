import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getProvider, getProviderCamps, getProviderPendingProposals } from '@/lib/admin/provider-repository';
import { getPool } from '@/lib/db';
import { cn } from '@/lib/utils';
import { ExternalLink, Building2 } from 'lucide-react';
import { CATEGORY_LABELS, STATUS_CONFIG } from '@/lib/types';
import type { CampCategory, RegistrationStatus, DataConfidence } from '@/lib/types';
import { ProviderEditor } from './provider-editor';

export const dynamic = 'force-dynamic';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeDate(dateStr: string | null | undefined): string {
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

function shortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={cn(
      'glass-panel p-4',
      highlight && 'border-amber-300/60 bg-amber-50/30'
    )}>
      <p className="text-xs text-bark-300 uppercase tracking-wide mb-1">{label}</p>
      <p className="font-display text-2xl font-extrabold text-bark-700">{value}</p>
    </div>
  );
}

function DataConfidenceBadge({ value }: { value: DataConfidence }) {
  const colors: Record<DataConfidence, string> = {
    VERIFIED: 'bg-pine-100 text-pine-700',
    STALE: 'bg-amber-100 text-amber-700',
    PLACEHOLDER: 'bg-red-100 text-red-600',
  };
  return (
    <span className={cn(
      'inline-block px-2 py-0.5 rounded-full text-xs font-semibold',
      colors[value] ?? 'bg-cream-200 text-bark-400'
    )}>
      {value}
    </span>
  );
}

function StatusBadge({ value }: { value: RegistrationStatus }) {
  const cfg = STATUS_CONFIG[value];
  return (
    <span className={cn(
      'inline-block px-2 py-0.5 rounded-full text-xs font-semibold',
      cfg?.color ?? 'bg-cream-200 text-bark-400'
    )}>
      {cfg?.label ?? value}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ProviderDetailPage({
  params,
}: {
  params: { providerId: string };
}) {
  const { providerId } = params;

  const [provider, camps, proposals] = await Promise.all([
    getProvider(providerId).catch(() => null),
    getProviderCamps(providerId).catch(() => [] as any[]),
    getProviderPendingProposals(providerId).catch(() => [] as any[]),
  ]);

  if (!provider) notFound();

  // Fetch crawl site hints
  const pool = getPool();
  const { rows: siteHints } = await pool
    .query<{ id: string; hint: string; active: boolean; createdAt: string }>(
      `SELECT id, hint, active, "createdAt" FROM "CrawlSiteHint" WHERE domain = $1 ORDER BY "createdAt" ASC`,
      [provider.domain]
    )
    .catch(() => ({ rows: [] as any[] }));

  const avgConfPct =
    provider.avgConfidence != null ? `${Math.round(provider.avgConfidence * 100)}%` : '—';

  return (
    <div className="space-y-8">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-bark-300 mb-1">
            <Link href="/admin/providers" className="hover:text-pine-500 transition-colors">
              Providers
            </Link>
            <span>/</span>
            <span className="text-bark-400 truncate">{provider.name}</span>
          </div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700 leading-tight">
            {provider.name}
          </h1>
          <div className="flex flex-wrap items-center gap-3 mt-2">
            {provider.domain && (
              <a
                href={provider.websiteUrl ?? `https://${provider.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-bark-400 hover:text-pine-500 transition-colors"
              >
                {provider.domain}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {provider.city && (
              <span className="text-xs text-bark-400">{provider.city}</span>
            )}
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-pine-100 text-pine-700 text-xs font-semibold">
              <Building2 className="w-3 h-3" />
              {provider.campCount ?? 0} camp{provider.campCount !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <div />
      </div>

      {/* ── Rollup stats ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Camps" value={provider.campCount ?? 0} />
        <StatCard
          label="Pending Reviews"
          value={provider.pendingProposals ?? 0}
          highlight={(provider.pendingProposals ?? 0) > 0}
        />
        <StatCard label="Last Crawled" value={relativeDate(provider.lastCrawledAt)} />
        <StatCard label="Avg Confidence" value={avgConfPct} />
      </div>

      {/* ── Pending proposals ── */}
      {proposals.length > 0 && (
        <div className="glass-panel overflow-hidden border-amber-300/60 bg-amber-50/20">
          <div className="px-5 py-4 border-b border-amber-200/60">
            <h2 className="font-display font-bold text-bark-700">
              Pending Reviews
              <span className="ml-2 inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-amber-400 text-white text-xs font-bold">
                {proposals.length}
              </span>
            </h2>
          </div>
          <div className="divide-y divide-amber-100/60">
            {proposals.map((p: any) => {
              const fieldCount = Object.keys(p.proposedChanges ?? {}).length;
              const confPct = p.overallConfidence != null
                ? Math.round(p.overallConfidence * 100)
                : null;
              return (
                <div key={p.id} className="px-5 py-3 flex items-center gap-4">
                  {confPct != null && (
                    <div className={cn(
                      'w-10 h-10 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0',
                      confPct >= 80 ? 'bg-pine-500' : confPct >= 50 ? 'bg-amber-400' : 'bg-red-400'
                    )}>
                      {confPct}%
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-bark-700 truncate">{p.campName}</p>
                    <p className="text-xs text-bark-400 mt-0.5">
                      {fieldCount} field{fieldCount !== 1 ? 's' : ''} changed ·{' '}
                      {shortDate(p.createdAt)}
                    </p>
                  </div>
                  <Link
                    href={`/admin/review/${p.id}`}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-700 text-xs font-semibold transition-colors"
                  >
                    Review →
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Provider info + crawl hints (inline editable) ── */}
      <ProviderEditor provider={provider} siteHints={siteHints} campCount={provider.campCount ?? 0} />

      {/* ── Camps table ── */}
      <div className="glass-panel overflow-hidden">
        <div className="px-5 py-4 border-b border-cream-300/60 flex items-center justify-between">
          <h2 className="font-display font-bold text-bark-700">
            Camps
            <span className="ml-2 text-sm font-normal text-bark-400">({camps.length})</span>
          </h2>
          <button
            disabled
            className="px-3 py-1.5 rounded-lg border border-cream-300 text-xs text-bark-400 hover:bg-cream-200 transition-colors"
            title="Coming soon"
          >
            + Add camp
          </button>
        </div>

        {camps.length === 0 ? (
          <div className="px-5 py-10 text-center text-bark-300 text-sm">
            No camps linked to this provider yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cream-200/60 text-xs text-bark-300 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-semibold">Camp</th>
                <th className="text-left px-4 py-3 font-semibold hidden sm:table-cell">Category</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold hidden md:table-cell">Confidence</th>
                <th className="text-left px-4 py-3 font-semibold hidden lg:table-cell">Last Verified</th>
                <th className="text-center px-4 py-3 font-semibold">Pending</th>
              </tr>
            </thead>
            <tbody>
              {camps.map((camp: any, i: number) => (
                <tr
                  key={camp.id}
                  className={cn(
                    'border-b border-cream-200/50 hover:bg-cream-100/60 transition-colors',
                    i % 2 === 0 ? 'bg-white/20' : 'bg-cream-50/30'
                  )}
                >
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/camps/${camp.id}`}
                      className="font-medium text-bark-700 hover:text-pine-600 transition-colors"
                    >
                      {camp.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 hidden sm:table-cell">
                    <span className="text-xs text-bark-400">
                      {CATEGORY_LABELS[camp.category as CampCategory] ?? camp.category ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge value={camp.registrationStatus as RegistrationStatus} />
                  </td>
                  <td className="px-4 py-2.5 hidden md:table-cell">
                    <DataConfidenceBadge value={camp.dataConfidence as DataConfidence} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-bark-400 hidden lg:table-cell">
                    {camp.lastVerifiedAt
                      ? shortDate(camp.lastVerifiedAt)
                      : <span className="text-red-400">Never</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {(camp.pendingCount ?? 0) > 0 ? (
                      <Link
                        href={`/admin/review?campId=${camp.id}`}
                        className="inline-flex items-center justify-center px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold hover:bg-amber-200 transition-colors min-w-[1.75rem]"
                      >
                        {camp.pendingCount}
                      </Link>
                    ) : (
                      <span className="text-bark-200 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
