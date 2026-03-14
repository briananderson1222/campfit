'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';

type Row = {
  campId: string;
  campName: string;
  campSlug: string;
  communitySlug: string;
  websiteUrl: string | null;
  latestError: string;
  latestUrl: string | null;
  latestRunId: string;
  latestStartedAt: string;
  failureCount: number;
};

function classifyError(error: string) {
  const lower = error.toLowerCase();
  if (lower.includes('http 404')) return 'MISSING_PAGE';
  if (lower.includes('http 403')) return 'BLOCKED';
  if (lower.includes('http 500') || lower.includes('http 502') || lower.includes('http 503') || lower.includes('http 522')) return 'SERVER_ERROR';
  if (lower.includes('page text too short')) return 'JS_OR_THIN_PAGE';
  if (lower.includes('parse error')) return 'PARSE_FAILURE';
  if (lower.includes('fetch failed')) return 'FETCH_FAILURE';
  return 'OTHER';
}

function recommendation(kind: string) {
  switch (kind) {
    case 'MISSING_PAGE':
      return 'Likely stale record. Archive or replace the URL.';
    case 'BLOCKED':
      return 'Site blocks bots. Verify manually or use provider-level hints/manual edits.';
    case 'JS_OR_THIN_PAGE':
      return 'Page may require JS/manual extraction. Fill fields manually if needed.';
    case 'SERVER_ERROR':
      return 'Source site unstable. Retry later or verify manually.';
    case 'PARSE_FAILURE':
      return 'Prompt/model issue or malformed response. Retry after crawl tuning.';
    default:
      return 'Investigate source URL and fill or archive manually.';
  }
}

export function CrawlFailuresTable({ rows }: { rows: Row[] }) {
  const [search, setSearch] = useState('');
  const [community, setCommunity] = useState('ALL');
  const [reason, setReason] = useState('ALL');

  const communities = useMemo(
    () => ['ALL', ...Array.from(new Set(rows.map((row) => row.communitySlug)))],
    [rows],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      const kind = classifyError(row.latestError);
      const matchesSearch = !query
        || row.campName.toLowerCase().includes(query)
        || row.campSlug.toLowerCase().includes(query)
        || row.latestError.toLowerCase().includes(query);
      const matchesCommunity = community === 'ALL' || row.communitySlug === community;
      const matchesReason = reason === 'ALL' || kind === reason;
      return matchesSearch && matchesCommunity && matchesReason;
    });
  }, [community, reason, rows, search]);

  return (
    <div className="space-y-4">
      <div className="glass-panel p-4 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Search</label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Camp name, slug, or error"
              className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="w-full lg:w-44">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Community</label>
            <select value={community} onChange={(event) => setCommunity(event.target.value)} className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm">
              {communities.map((value) => (
                <option key={value} value={value}>{value === 'ALL' ? 'All communities' : value}</option>
              ))}
            </select>
          </div>
          <div className="w-full lg:w-56">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Failure Type</label>
            <select value={reason} onChange={(event) => setReason(event.target.value)} className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm">
              <option value="ALL">All failure types</option>
              <option value="MISSING_PAGE">Missing page</option>
              <option value="BLOCKED">Blocked</option>
              <option value="JS_OR_THIN_PAGE">JS / thin page</option>
              <option value="SERVER_ERROR">Server error</option>
              <option value="PARSE_FAILURE">Parse failure</option>
              <option value="FETCH_FAILURE">Fetch failure</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-bark-400">Showing {filtered.length} of {rows.length} uncrawlable camps</p>
      </div>

      <div className="space-y-3">
        {filtered.map((row) => {
          const kind = classifyError(row.latestError);
          return (
            <div key={row.campId} className="glass-panel p-5 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/camps/${row.campId}`} className="font-semibold text-bark-700 hover:text-pine-600">
                      {row.campName}
                    </Link>
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">{kind}</span>
                    <span className="rounded-full bg-cream-200 px-2 py-0.5 text-[11px] font-semibold text-bark-500">{row.failureCount} failures</span>
                  </div>
                  <p className="mt-1 text-xs text-bark-400">
                    {row.communitySlug} · latest failure {new Date(row.latestStartedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/admin/camps/${row.campId}`} className="btn-secondary text-xs">Open camp</Link>
                  <Link href={`/admin/crawls?runId=${row.latestRunId}`} className="btn-secondary text-xs">View crawl log</Link>
                  {row.latestUrl && (
                    <a href={row.latestUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs">
                      Source <ExternalLink className="ml-1 inline h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {row.latestError}
              </div>

              <p className="text-sm text-bark-500">{recommendation(kind)}</p>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="glass-panel p-12 text-center text-bark-300">No uncrawlable camps match the current filters.</div>
        )}
      </div>
    </div>
  );
}
