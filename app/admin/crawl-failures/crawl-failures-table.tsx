'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Save, Lightbulb } from 'lucide-react';

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

/**
 * Error-vocabulary parity (traverse-recrawl-cutover plan, Task 2.2 / AC9):
 * two error vocabularies now reach this table:
 *
 *  1. LEGACY hand-rolled extractor strings (from the pre-migration per-camp
 *     extraction module, deleted in Wave 3 — see the migration doc for its
 *     retired name) — kept verbatim below so historical failure rows (crawl
 *     runs from before this migration) still classify correctly. Do not
 *     remove these even though the module that produced them is gone — the
 *     STRINGS persisted in `CrawlRun.errorLog`/`campLog` outlive the code
 *     that produced them.
 *  2. TRAVERSE's structured `FetchErrorKind` vocabulary
 *     (`node_modules/@kontourai/traverse/dist/src/fetch/types.d.ts`), which
 *     `traverse-pipeline.ts:401` formats as `` `${kind}: ${message}` ``, plus
 *     `traverse-recrawl-adapter.ts`'s own `traverse-recrawl:<reason>:` item-
 *     selection-failure strings (`no-items` / `ambiguous-multi-item`) and
 *     this route's own `traverse-recrawl:provider-unavailable:` (surfaced by
 *     `crawl-pipeline.ts` when the datum-resolved extraction provider itself
 *     fails to resolve, e.g. a missing API key — AC13's operational-readiness
 *     gap made visible here instead of silently no-oping).
 */
function classifyError(error: string) {
  const lower = error.toLowerCase();

  // ── traverse-recrawl-adapter.ts / crawl-pipeline.ts's own tagged strings ──
  // (`traverse-recrawl:<reason>: ...`) — checked first since they're the most
  // specific/unambiguous prefix.
  if (lower.startsWith('traverse-recrawl:no-items')) return 'NO_ITEMS';
  if (lower.startsWith('traverse-recrawl:ambiguous-multi-item')) return 'AMBIGUOUS_MATCH';
  if (lower.startsWith('traverse-recrawl:provider-unavailable')) return 'CONFIG_ERROR';

  // ── traverse's FetchErrorKind vocabulary (`${kind}: ${message}`) ──────────
  if (lower.startsWith('http-error:')) {
    const status = Number(lower.match(/http (\d{3})/)?.[1] ?? NaN);
    if (status === 404) return 'MISSING_PAGE';
    if (status === 401 || status === 403 || status === 429) return 'BLOCKED';
    if (status >= 500) return 'SERVER_ERROR';
    return 'HTTP_ERROR';
  }
  if (lower.startsWith('invalid-url:')) return 'INVALID_URL';
  if (lower.startsWith('invalid-config:')) return 'CONFIG_ERROR';
  if (lower.startsWith('robots-denied:')) return 'ROBOTS_BLOCKED';
  if (lower.startsWith('timeout:')) return 'TIMEOUT';
  if (lower.startsWith('too-many-redirects:')) return 'TOO_MANY_REDIRECTS';
  if (lower.startsWith('no-snapshot:')) return 'NO_SNAPSHOT';
  if (lower.startsWith('network:')) return 'FETCH_FAILURE';

  // ── legacy hand-rolled extractor strings (kept: historical rows) ─────────
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
    case 'ROBOTS_BLOCKED':
      return "robots.txt disallows this bot. Confirm that's intentional, or verify/fill this camp manually instead of crawling.";
    case 'JS_OR_THIN_PAGE':
      return 'Page may require JS/manual extraction. Fill fields manually if needed.';
    case 'SERVER_ERROR':
      return 'Source site unstable. Retry later or verify manually.';
    case 'HTTP_ERROR':
      return 'Unusual HTTP status from the source page. Inspect the URL manually.';
    case 'TOO_MANY_REDIRECTS':
      return 'Site has a redirect chain/loop that is too long. Verify the URL manually.';
    case 'TIMEOUT':
      return 'Source site was slow or unresponsive. Retry later.';
    case 'INVALID_URL':
      return "Website URL isn't a valid absolute http(s) URL. Fix it below.";
    case 'CONFIG_ERROR':
      return 'Crawl configuration issue (not site-specific) — likely a missing/misconfigured extraction provider key. Needs an engineer, not a URL fix.';
    case 'NO_SNAPSHOT':
      return 'No page snapshot was captured for this fetch. Retry the crawl; if it recurs, check the traverse snapshot store.';
    case 'NO_ITEMS':
      return 'Traverse found no extractable camp/program content on this page. Verify the URL points at a program page.';
    case 'AMBIGUOUS_MATCH':
      return "This page lists multiple programs and traverse couldn't tell which one is this camp. Point the URL at this camp's own detail page, or add a disambiguating crawl hint.";
    case 'PARSE_FAILURE':
      return 'Prompt/model issue or malformed response. Retry after crawl tuning.';
    case 'FETCH_FAILURE':
      return 'Network error reaching the source page. Retry later or verify the URL manually.';
    default:
      return 'Investigate source URL and fill or archive manually.';
  }
}

export function CrawlFailuresTable({ rows }: { rows: Row[] }) {
  const [search, setSearch] = useState('');
  const [community, setCommunity] = useState('ALL');
  const [reason, setReason] = useState('ALL');
  const [draftUrls, setDraftUrls] = useState<Record<string, string>>({});
  const [draftHints, setDraftHints] = useState<Record<string, string>>({});
  const [savingUrlFor, setSavingUrlFor] = useState<string | null>(null);
  const [savingHintFor, setSavingHintFor] = useState<string | null>(null);
  const [retryingFor, setRetryingFor] = useState<string | null>(null);
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});

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
              <option value="ROBOTS_BLOCKED">Robots-denied</option>
              <option value="JS_OR_THIN_PAGE">JS / thin page</option>
              <option value="SERVER_ERROR">Server error</option>
              <option value="HTTP_ERROR">Other HTTP error</option>
              <option value="TOO_MANY_REDIRECTS">Too many redirects</option>
              <option value="TIMEOUT">Timeout</option>
              <option value="INVALID_URL">Invalid URL</option>
              <option value="CONFIG_ERROR">Config error</option>
              <option value="NO_SNAPSHOT">No snapshot</option>
              <option value="NO_ITEMS">No items found</option>
              <option value="AMBIGUOUS_MATCH">Ambiguous match</option>
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
          const effectiveUrl = draftUrls[row.campId] ?? row.websiteUrl ?? row.latestUrl ?? '';
          const domain = domainOf(effectiveUrl);
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
                  <button
                    onClick={async () => {
                      setRetryingFor(row.campId);
                      setRowMessages((prev) => ({ ...prev, [row.campId]: '' }));
                      try {
                        const res = await fetch(`/api/admin/camps/${row.campId}/crawl`, { method: 'POST' });
                        const body = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(body.error ?? 'Failed to retry crawl');
                        setRowMessages((prev) => ({ ...prev, [row.campId]: `Retry started · run ${body.runId}` }));
                      } catch (error) {
                        setRowMessages((prev) => ({ ...prev, [row.campId]: error instanceof Error ? error.message : 'Failed to retry crawl' }));
                      } finally {
                        setRetryingFor(null);
                      }
                    }}
                    className="btn-secondary text-xs"
                  >
                    {retryingFor === row.campId ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 inline h-3 w-3" />}
                    Retry
                  </button>
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

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-cream-300 bg-white/70 p-3">
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Fix website URL</label>
                  <div className="flex gap-2">
                    <input
                      value={effectiveUrl}
                      onChange={(event) => setDraftUrls((prev) => ({ ...prev, [row.campId]: event.target.value }))}
                      placeholder="https://..."
                      className="flex-1 rounded-lg border border-cream-300 px-3 py-2 text-sm"
                    />
                    <button
                      onClick={async () => {
                        setSavingUrlFor(row.campId);
                        setRowMessages((prev) => ({ ...prev, [row.campId]: '' }));
                        try {
                          const res = await fetch(`/api/admin/camps/${row.campId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ websiteUrl: effectiveUrl.trim() || null }),
                          });
                          const body = await res.json().catch(() => ({}));
                          if (!res.ok) throw new Error(body.error ?? 'Failed to save URL');
                          setRowMessages((prev) => ({ ...prev, [row.campId]: 'Website URL saved' }));
                        } catch (error) {
                          setRowMessages((prev) => ({ ...prev, [row.campId]: error instanceof Error ? error.message : 'Failed to save URL' }));
                        } finally {
                          setSavingUrlFor(null);
                        }
                      }}
                      className="btn-secondary text-xs"
                    >
                      {savingUrlFor === row.campId ? <Loader2 className="inline h-3 w-3 animate-spin" /> : <Save className="inline h-3 w-3" />}
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-cream-300 bg-white/70 p-3">
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">Add crawl hint</label>
                  <div className="flex gap-2">
                    <input
                      value={draftHints[row.campId] ?? ''}
                      onChange={(event) => setDraftHints((prev) => ({ ...prev, [row.campId]: event.target.value }))}
                      placeholder={domain ? `Hint for ${domain}` : 'Set/fix URL first if needed'}
                      className="flex-1 rounded-lg border border-cream-300 px-3 py-2 text-sm"
                    />
                    <button
                      onClick={async () => {
                        if (!domain || !(draftHints[row.campId] ?? '').trim()) return;
                        setSavingHintFor(row.campId);
                        setRowMessages((prev) => ({ ...prev, [row.campId]: '' }));
                        try {
                          const res = await fetch('/api/admin/site-hints', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              domain,
                              hint: (draftHints[row.campId] ?? '').trim(),
                              source: 'manual',
                              sourceId: row.campId,
                            }),
                          });
                          const body = await res.json().catch(() => ({}));
                          if (!res.ok) throw new Error(body.error ?? 'Failed to save hint');
                          setDraftHints((prev) => ({ ...prev, [row.campId]: '' }));
                          setRowMessages((prev) => ({ ...prev, [row.campId]: `Saved crawl hint for ${domain}` }));
                        } catch (error) {
                          setRowMessages((prev) => ({ ...prev, [row.campId]: error instanceof Error ? error.message : 'Failed to save hint' }));
                        } finally {
                          setSavingHintFor(null);
                        }
                      }}
                      disabled={!domain || !(draftHints[row.campId] ?? '').trim()}
                      className="btn-secondary text-xs disabled:opacity-40"
                    >
                      {savingHintFor === row.campId ? <Loader2 className="inline h-3 w-3 animate-spin" /> : <Lightbulb className="inline h-3 w-3" />}
                    </button>
                  </div>
                </div>
              </div>

              {rowMessages[row.campId] && (
                <p className="text-xs text-pine-600">{rowMessages[row.campId]}</p>
              )}
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

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
