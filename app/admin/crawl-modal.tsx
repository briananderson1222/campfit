'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Play, X, RefreshCw, Loader2, CheckCircle, XCircle,
  AlertTriangle, Clock, Zap, Calendar, Database,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CrawlPriority, CrawlPreviewCamp } from '@/app/api/admin/crawl/preview/route';

type RunState = 'idle' | 'running' | 'done' | 'error';

const PRIORITY_OPTIONS: { value: CrawlPriority; label: string; description: string; icon: React.ReactNode }[] = [
  {
    value: 'stale',
    label: 'Most Stale',
    description: 'Camps not verified recently, scored by days since last crawl',
    icon: <Clock className="w-4 h-4" />,
  },
  {
    value: 'missing',
    label: 'Missing Data',
    description: 'Camps with empty description, neighborhood, or unknown status',
    icon: <Database className="w-4 h-4" />,
  },
  {
    value: 'coming_soon',
    label: 'Opening Soon',
    description: 'Registration opening soon — time-sensitive to get accurate dates',
    icon: <Calendar className="w-4 h-4" />,
  },
  {
    value: 'never_crawled',
    label: 'Never Crawled',
    description: 'Camps that have never been verified by the crawler',
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  {
    value: 'all',
    label: 'Highest Priority',
    description: 'Combined score: staleness + missing fields + time-sensitive status',
    icon: <Zap className="w-4 h-4" />,
  },
];

const LIMIT_OPTIONS = [5, 10, 20, 50];

function formatDate(iso: string | null) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const CONFIDENCE_COLORS: Record<string, string> = {
  VERIFIED: 'text-pine-500',
  STALE: 'text-amber-500',
  PLACEHOLDER: 'text-red-500',
};

export function CrawlModal() {
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<CrawlPriority>('all');
  const [limit, setLimit] = useState(10);
  const [preview, setPreview] = useState<{ camps: CrawlPreviewCamp[]; totalCrawlable: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [runState, setRunState] = useState<RunState>('idle');
  const [runProgress, setRunProgress] = useState<{ processed: number; total: number; proposals: number; errors: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/admin/crawl/preview?priority=${priority}&limit=${limit}`);
      if (res.ok) setPreview(await res.json());
    } finally {
      setPreviewLoading(false);
    }
  }, [priority, limit]);

  useEffect(() => {
    if (open && runState === 'idle') fetchPreview();
  }, [open, priority, limit, fetchPreview, runState]);

  const startCrawl = async () => {
    if (!preview?.camps.length) return;
    const campIds = preview.camps.map(c => c.id);

    setRunState('running');
    setRunProgress({ processed: 0, total: campIds.length, proposals: 0, errors: 0 });
    setErrorMsg(null);

    try {
      const res = await fetch('/api/admin/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campIds }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { runId } = await res.json();

      const poll = setInterval(async () => {
        const r = await fetch(`/api/admin/crawl/${runId}/status-json`).catch(() => null);
        if (!r) return;
        const data = await r.json().catch(() => null);
        if (!data) return;
        setRunProgress({
          processed: data.processedCamps ?? 0,
          total: data.totalCamps ?? campIds.length,
          proposals: data.newProposals ?? 0,
          errors: data.errorCount ?? 0,
        });
        if (data.status === 'COMPLETED') {
          clearInterval(poll);
          setRunState('done');
        } else if (data.status === 'FAILED') {
          clearInterval(poll);
          setRunState('error');
          setErrorMsg('Crawl failed');
        }
      }, 3000);

      setTimeout(() => clearInterval(poll), 310_000);
    } catch (err) {
      setRunState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  const reset = () => {
    setRunState('idle');
    setRunProgress(null);
    setErrorMsg(null);
    setPreview(null);
  };

  const close = () => {
    setOpen(false);
    if (runState === 'done' || runState === 'error') reset();
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary gap-2">
        <Play className="w-4 h-4" />
        Run Crawl
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-bark-900/40 backdrop-blur-sm" onClick={close} />

          {/* Modal */}
          <div className="relative w-full max-w-2xl glass-panel rounded-2xl shadow-camp-hover overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-cream-300/40">
              <div>
                <h2 className="font-display font-bold text-xl text-bark-700">Configure Crawl</h2>
                {preview && (
                  <p className="text-xs text-bark-300 mt-0.5">
                    {preview.totalCrawlable} camps have crawlable URLs
                  </p>
                )}
              </div>
              <button onClick={close} className="p-1.5 rounded-xl hover:bg-cream-200/60 text-bark-400 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Running state */}
            {runState === 'running' && (
              <div className="px-6 py-10 text-center">
                <Loader2 className="w-10 h-10 text-pine-500 animate-spin mx-auto mb-4" />
                <p className="font-medium text-bark-700 text-lg">
                  Crawling {runProgress?.processed ?? 0} / {runProgress?.total ?? '?'} camps…
                </p>
                {(runProgress?.proposals ?? 0) > 0 && (
                  <p className="text-sm text-pine-600 mt-1">{runProgress!.proposals} proposals found so far</p>
                )}
                {(runProgress?.errors ?? 0) > 0 && (
                  <p className="text-sm text-red-400 mt-1">{runProgress!.errors} errors</p>
                )}
                <p className="text-xs text-bark-300 mt-4">
                  This runs in the background — you can close this window
                </p>
              </div>
            )}

            {/* Done state */}
            {runState === 'done' && (
              <div className="px-6 py-10 text-center">
                <CheckCircle className="w-10 h-10 text-pine-500 mx-auto mb-4" />
                <p className="font-bold text-bark-700 text-lg">Crawl complete</p>
                <p className="text-bark-400 mt-1">
                  {runProgress?.processed} camps processed · {runProgress?.proposals} proposals · {runProgress?.errors} errors
                </p>
                <div className="flex gap-3 justify-center mt-6">
                  <button onClick={reset} className="btn-secondary gap-2 text-sm">
                    <RefreshCw className="w-3.5 h-3.5" /> Run Another
                  </button>
                  <a href="/admin/review" className="btn-primary text-sm">
                    Review Proposals →
                  </a>
                </div>
              </div>
            )}

            {/* Error state */}
            {runState === 'error' && (
              <div className="px-6 py-8 text-center">
                <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
                <p className="font-bold text-bark-700">Crawl failed</p>
                <p className="text-red-400 text-sm mt-1">{errorMsg}</p>
                <button onClick={reset} className="btn-secondary mt-4 text-sm gap-2">
                  <RefreshCw className="w-3.5 h-3.5" /> Try Again
                </button>
              </div>
            )}

            {/* Config state */}
            {runState === 'idle' && (
              <>
                <div className="px-6 py-5 space-y-5">
                  {/* Priority selector */}
                  <div>
                    <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">
                      Prioritization Strategy
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {PRIORITY_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setPriority(opt.value)}
                          className={cn(
                            'flex items-start gap-2.5 p-3 rounded-xl border text-left transition-all',
                            priority === opt.value
                              ? 'border-pine-400 bg-pine-50 text-pine-700'
                              : 'border-cream-300/60 hover:border-cream-400 hover:bg-cream-100/60 text-bark-500'
                          )}
                        >
                          <span className={cn('mt-0.5 shrink-0', priority === opt.value ? 'text-pine-500' : 'text-bark-300')}>
                            {opt.icon}
                          </span>
                          <div>
                            <p className="text-sm font-semibold leading-tight">{opt.label}</p>
                            <p className="text-xs opacity-70 mt-0.5 leading-snug">{opt.description}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Limit selector */}
                  <div>
                    <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">
                      How many camps to crawl
                    </label>
                    <div className="flex gap-2">
                      {LIMIT_OPTIONS.map(n => (
                        <button
                          key={n}
                          onClick={() => setLimit(n)}
                          className={cn(
                            'px-4 py-2 rounded-xl text-sm font-semibold border transition-all',
                            limit === n
                              ? 'border-pine-400 bg-pine-50 text-pine-700'
                              : 'border-cream-300/60 hover:border-cream-400 text-bark-400'
                          )}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Preview list */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide">
                        Preview — camps that will be crawled
                      </label>
                      <button
                        onClick={fetchPreview}
                        className="text-xs text-pine-500 hover:text-pine-600 flex items-center gap-1"
                        disabled={previewLoading}
                      >
                        <RefreshCw className={cn('w-3 h-3', previewLoading && 'animate-spin')} />
                        Refresh
                      </button>
                    </div>

                    {previewLoading ? (
                      <div className="flex items-center gap-2 py-4 text-bark-300 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading preview…
                      </div>
                    ) : preview?.camps.length ? (
                      <div className="border border-cream-300/40 rounded-xl overflow-hidden max-h-52 overflow-y-auto">
                        {preview.camps.map((camp, i) => (
                          <div
                            key={camp.id}
                            className={cn(
                              'flex items-center gap-3 px-3 py-2 text-sm',
                              i % 2 === 0 ? 'bg-white/30' : 'bg-cream-50/30'
                            )}
                          >
                            <span className="text-bark-300 text-xs w-5 text-right shrink-0">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-bark-600 truncate">{camp.name}</p>
                              <p className="text-xs text-bark-300">{camp.communitySlug}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 text-xs">
                              <span className={cn('font-medium', CONFIDENCE_COLORS[camp.dataConfidence] ?? 'text-bark-300')}>
                                {camp.dataConfidence}
                              </span>
                              <span className="text-bark-300">{formatDate(camp.lastVerifiedAt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-bark-300 text-sm py-3">
                        No camps match this filter. Try a different strategy.
                      </p>
                    )}
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-cream-300/40 bg-cream-50/30">
                  <p className="text-sm text-bark-400">
                    {preview?.camps.length
                      ? `Will crawl ${preview.camps.length} camps`
                      : 'Select a strategy to preview'}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={close} className="btn-secondary text-sm">Cancel</button>
                    <button
                      onClick={startCrawl}
                      disabled={!preview?.camps.length || previewLoading}
                      className="btn-primary text-sm gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Play className="w-3.5 h-3.5" />
                      Start Crawl
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
