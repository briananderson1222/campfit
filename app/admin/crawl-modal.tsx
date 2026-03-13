'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Play, X, RefreshCw, Loader2, CheckCircle, XCircle,
  AlertTriangle, Clock, Zap, Calendar, Database, Search, Telescope, Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CrawlPriority, CrawlPreviewCamp } from '@/app/api/admin/crawl/preview/route';
import type { LLMModel } from '@/app/api/admin/crawl/models/route';

type RunState = 'idle' | 'running' | 'done' | 'error';
type ModalPriority = CrawlPriority | 'onboard_url';

const PRIORITY_OPTIONS: { value: ModalPriority; label: string; description: string; icon: React.ReactNode }[] = [
  { value: 'all',          label: 'Highest Priority', description: 'Combined score: staleness + missing fields + time-sensitive', icon: <Zap className="w-4 h-4" /> },
  { value: 'stale',        label: 'Most Stale',       description: 'Not verified recently, scored by days since last crawl',    icon: <Clock className="w-4 h-4" /> },
  { value: 'missing',      label: 'Missing Data',     description: 'Empty description, neighborhood, or unknown status',        icon: <Database className="w-4 h-4" /> },
  { value: 'coming_soon',  label: 'Opening Soon',     description: 'Registration opening soon — time-sensitive accuracy',       icon: <Calendar className="w-4 h-4" /> },
  { value: 'never_crawled',label: 'Never Crawled',    description: 'Camps that have never been verified by the crawler',        icon: <AlertTriangle className="w-4 h-4" /> },
  { value: 'specific',     label: 'Specific Camp',    description: 'Search for and crawl one or more camps by name',           icon: <Search className="w-4 h-4" /> },
  { value: 'onboard_url', label: 'Onboard New Site', description: 'Discover all programs from a new website and add them to the database', icon: <Globe className="w-4 h-4" /> },
];

const LIMIT_OPTIONS = [5, 10, 20, 50];

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'bg-violet-100 text-violet-700',
  gemini:    'bg-blue-100 text-blue-700',
  ollama:    'bg-bark-100 text-bark-600',
};

function modelBadgeClass(badge: string, provider: string): string {
  if (badge === 'No Key') return 'bg-red-100 text-red-500 line-through opacity-60';
  if (badge === 'Local Only') return 'bg-amber-100 text-amber-600';
  return PROVIDER_COLORS[provider] ?? 'bg-gray-100 text-gray-600';
}

function isModelDisabled(badge: string): boolean {
  return badge === 'No Key' || badge === 'Local Only';
}

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
  VERIFIED:    'text-pine-500',
  STALE:       'text-amber-500',
  PLACEHOLDER: 'text-red-500',
};

export function CrawlModal({
  trigger,
  retryWithCampIds,
  forceOpen,
  onClose,
}: {
  trigger?: React.ReactNode;
  retryWithCampIds?: string[];
  forceOpen?: boolean;
  onClose?: () => void;
} = {}) {
  const isRetry = !!retryWithCampIds?.length;
  const [open, setOpen] = useState(forceOpen ?? false);
  const [priority, setPriority] = useState<ModalPriority>(isRetry ? 'specific' : 'all');
  const [limit, setLimit] = useState(10);
  const [onboardUrl, setOnboardUrl] = useState('');

  // Model selection
  const [models, setModels] = useState<LLMModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Specific-camp search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CrawlPreviewCamp[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedCampIds, setSelectedCampIds] = useState<Set<string>>(
    isRetry ? new Set(retryWithCampIds) : new Set()
  );
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Preview (for non-specific modes)
  const [preview, setPreview] = useState<{ camps: CrawlPreviewCamp[]; totalCrawlable: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Pre-load retry camps when modal opens
  useEffect(() => {
    if (!open || !isRetry || searchResults.length > 0) return;
    setSearchLoading(true);
    fetch(`/api/admin/crawl/preview?ids=${retryWithCampIds!.join(',')}`)
      .then(r => r.json())
      .then(d => setSearchResults(d.camps ?? []))
      .catch(() => {})
      .finally(() => setSearchLoading(false));
  }, [open, isRetry, retryWithCampIds, searchResults.length]);

  // Options
  const [discover, setDiscover] = useState(false);

  // Run state
  const [runState, setRunState] = useState<RunState>('idle');
  const [runProgress, setRunProgress] = useState<{ processed: number; total: number; proposals: number; errors: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load models once on open
  useEffect(() => {
    if (!open || models.length > 0) return;
    fetch('/api/admin/crawl/models')
      .then(r => r.json())
      .then(d => {
        setModels(d.models ?? []);
        if (!selectedModel) setSelectedModel(d.default ?? '');
      })
      .catch(() => {});
  }, [open, models.length, selectedModel]);

  const fetchPreview = useCallback(async () => {
    if (priority === 'specific' || priority === 'onboard_url') return;
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/admin/crawl/preview?priority=${priority}&limit=${limit}`);
      if (res.ok) setPreview(await res.json());
    } finally {
      setPreviewLoading(false);
    }
  }, [priority, limit]);

  useEffect(() => {
    if (open && runState === 'idle' && priority !== 'specific' && priority !== 'onboard_url') fetchPreview();
  }, [open, priority, limit, fetchPreview, runState]);

  // Debounced search for specific camp
  useEffect(() => {
    if (priority !== 'specific') return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/admin/crawl/preview?priority=specific&q=${encodeURIComponent(searchQuery)}&limit=10`);
        if (res.ok) {
          const d = await res.json();
          setSearchResults(d.camps ?? []);
        }
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, [searchQuery, priority]);

  const toggleCamp = (id: string) => {
    setSelectedCampIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Camps that will actually be crawled
  const crawlCamps = priority === 'specific'
    ? searchResults.filter(c => selectedCampIds.has(c.id))
    : (preview?.camps ?? []);

  const startCrawl = async () => {
    // Onboard URL mode — separate flow
    if (priority === 'onboard_url') {
      if (!onboardUrl.trim()) return;
      setRunState('running');
      setRunProgress({ processed: 0, total: 0, proposals: 0, errors: 0 });
      setErrorMsg(null);
      try {
        const res = await fetch('/api/admin/crawl/onboard-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: onboardUrl.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setRunState('error');
          setErrorMsg(data.error ?? 'Failed to onboard site');
          return;
        }
        const { runId, creating } = data as { runId: string; creating: number };
        setRunProgress({ processed: 0, total: creating, proposals: 0, errors: 0 });

        const poll = setInterval(async () => {
          const r = await fetch(`/api/admin/crawl/${runId}/status-json`).catch(() => null);
          if (!r) return;
          const d = await r.json().catch(() => null);
          if (!d) return;
          setRunProgress({ processed: d.processedCamps ?? 0, total: d.totalCamps ?? creating, proposals: d.newProposals ?? 0, errors: d.errorCount ?? 0 });
          if (d.status === 'COMPLETED') { clearInterval(poll); setRunState('done'); }
          else if (d.status === 'FAILED') { clearInterval(poll); setRunState('error'); setErrorMsg('Crawl failed'); }
        }, 3000);

        setTimeout(() => clearInterval(poll), 310_000);
      } catch (err) {
        setRunState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Error');
      }
      return;
    }

    if (!crawlCamps.length) return;
    const campIds = crawlCamps.map(c => c.id);

    setRunState('running');
    setRunProgress({ processed: 0, total: campIds.length, proposals: 0, errors: 0 });
    setErrorMsg(null);

    try {
      const res = await fetch('/api/admin/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campIds, model: selectedModel || undefined, discover }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { runId } = await res.json();

      const poll = setInterval(async () => {
        const r = await fetch(`/api/admin/crawl/${runId}/status-json`).catch(() => null);
        if (!r) return;
        const data = await r.json().catch(() => null);
        if (!data) return;
        setRunProgress({ processed: data.processedCamps ?? 0, total: data.totalCamps ?? campIds.length, proposals: data.newProposals ?? 0, errors: data.errorCount ?? 0 });
        if (data.status === 'COMPLETED') { clearInterval(poll); setRunState('done'); }
        else if (data.status === 'FAILED') { clearInterval(poll); setRunState('error'); setErrorMsg('Crawl failed'); }
      }, 3000);

      setTimeout(() => clearInterval(poll), 310_000);
    } catch (err) {
      setRunState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  const reset = () => {
    setRunState('idle'); setRunProgress(null); setErrorMsg(null);
    setPreview(null);
    setSearchQuery('');
    setOnboardUrl('');
    if (!isRetry) {
      setSelectedCampIds(new Set());
      setSearchResults([]);
    }
  };

  const close = () => {
    setOpen(false);
    onClose?.();
    if (runState === 'done' || runState === 'error') reset();
  };

  return (
    <>
      {trigger
        ? <span onClick={() => setOpen(true)}>{trigger}</span>
        : (
          <button onClick={() => setOpen(true)} className="btn-primary gap-2">
            <Play className="w-4 h-4" />
            Run Crawl
          </button>
        )
      }

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-bark-900/40 backdrop-blur-sm" onClick={close} />

          <div className="relative w-full max-w-2xl glass-panel rounded-2xl shadow-camp-hover overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-cream-300/40">
              <div>
                <h2 className="font-display font-bold text-xl text-bark-700">{isRetry ? 'Retry Crawl' : 'Configure Crawl'}</h2>
                {preview && priority !== 'specific' && (
                  <p className="text-xs text-bark-300 mt-0.5">{preview.totalCrawlable} camps have crawlable URLs</p>
                )}
              </div>
              <button onClick={close} className="p-1.5 rounded-xl hover:bg-cream-200/60 text-bark-400 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Running */}
            {runState === 'running' && (
              <div className="px-6 py-10 text-center">
                <Loader2 className="w-10 h-10 text-pine-500 animate-spin mx-auto mb-4" />
                <p className="font-medium text-bark-700 text-lg">
                  Crawling {runProgress?.processed ?? 0} / {runProgress?.total ?? '?'} camps…
                </p>
                {(runProgress?.proposals ?? 0) > 0 && <p className="text-sm text-pine-600 mt-1">{runProgress!.proposals} proposals found so far</p>}
                {(runProgress?.errors ?? 0) > 0 && <p className="text-sm text-red-400 mt-1">{runProgress!.errors} errors</p>}
                <p className="text-xs text-bark-300 mt-4">This runs in the background — you can close this window</p>
              </div>
            )}

            {/* Done */}
            {runState === 'done' && (
              <div className="px-6 py-10 text-center">
                <CheckCircle className="w-10 h-10 text-pine-500 mx-auto mb-4" />
                <p className="font-bold text-bark-700 text-lg">Crawl complete</p>
                <p className="text-bark-400 mt-1">{runProgress?.processed} camps · {runProgress?.proposals} proposals · {runProgress?.errors} errors</p>
                <div className="flex gap-3 justify-center mt-6">
                  <button onClick={reset} className="btn-secondary gap-2 text-sm"><RefreshCw className="w-3.5 h-3.5" /> Run Another</button>
                  <a href="/admin/review" className="btn-primary text-sm">Review Proposals →</a>
                </div>
              </div>
            )}

            {/* Error */}
            {runState === 'error' && (
              <div className="px-6 py-8 text-center">
                <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
                <p className="font-bold text-bark-700">Crawl failed</p>
                <p className="text-red-400 text-sm mt-1">{errorMsg}</p>
                <button onClick={reset} className="btn-secondary mt-4 text-sm gap-2"><RefreshCw className="w-3.5 h-3.5" /> Try Again</button>
              </div>
            )}

            {/* Config */}
            {runState === 'idle' && (
              <>
                <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
                  {/* Strategy */}
                  <div>
                    <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">Strategy</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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
                          <span className={cn('mt-0.5 shrink-0', priority === opt.value ? 'text-pine-500' : 'text-bark-300')}>{opt.icon}</span>
                          <div>
                            <p className="text-sm font-semibold leading-tight">{opt.label}</p>
                            <p className="text-xs opacity-70 mt-0.5 leading-snug">{opt.description}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Specific camp search */}
                  {priority === 'specific' && (
                    <div>
                      <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">Search camps</label>
                      <div className="relative mb-2">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bark-300" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          placeholder="Type a camp name…"
                          className="w-full pl-9 pr-4 py-2 rounded-xl border border-cream-300/60 text-sm text-bark-700 bg-white/60 focus:outline-none focus:border-pine-400"
                          autoFocus
                        />
                        {searchLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-pine-400 animate-spin" />}
                      </div>

                      {searchResults.length > 0 && (
                        <div className="border border-cream-300/40 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                          {searchResults.map((camp, i) => (
                            <label
                              key={camp.id}
                              className={cn(
                                'flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer transition-colors',
                                i % 2 === 0 ? 'bg-white/30' : 'bg-cream-50/30',
                                selectedCampIds.has(camp.id) ? 'bg-pine-50/60' : 'hover:bg-cream-100/60'
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={selectedCampIds.has(camp.id)}
                                onChange={() => toggleCamp(camp.id)}
                                className="rounded accent-pine-600"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-bark-600 truncate">{camp.name}</p>
                                <p className="text-xs text-bark-300">{camp.communitySlug}</p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0 text-xs">
                                <span className={cn('font-medium', CONFIDENCE_COLORS[camp.dataConfidence] ?? 'text-bark-300')}>{camp.dataConfidence}</span>
                                <span className="text-bark-300">{formatDate(camp.lastVerifiedAt)}</span>
                              </div>
                            </label>
                          ))}
                        </div>
                      )}

                      {searchQuery && !searchLoading && searchResults.length === 0 && (
                        <p className="text-bark-300 text-sm py-2">No camps found with a crawlable URL.</p>
                      )}

                      {selectedCampIds.size > 0 && (
                        <p className="text-xs text-pine-600 mt-2">{selectedCampIds.size} camp{selectedCampIds.size !== 1 ? 's' : ''} selected</p>
                      )}
                    </div>
                  )}

                  {/* Onboard URL input */}
                  {priority === 'onboard_url' && (
                    <div>
                      <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">Site URL</label>
                      <input
                        type="text"
                        value={onboardUrl}
                        onChange={e => setOnboardUrl(e.target.value)}
                        placeholder="https://example.com/camps"
                        className="w-full px-4 py-2 rounded-xl border border-cream-300/60 text-sm text-bark-700 bg-white/60 focus:outline-none focus:border-pine-400"
                        autoFocus
                      />
                      <p className="text-xs text-bark-300 mt-1.5">Enter the URL of a page listing camp programs. Discovery will find all programs and add them to the database.</p>
                    </div>
                  )}

                  {/* Limit — hide for specific and onboard_url modes */}
                  {priority !== 'specific' && priority !== 'onboard_url' && (
                    <div>
                      <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">Batch size</label>
                      <div className="flex gap-2">
                        {LIMIT_OPTIONS.map(n => (
                          <button
                            key={n}
                            onClick={() => setLimit(n)}
                            className={cn(
                              'px-4 py-2 rounded-xl text-sm font-semibold border transition-all',
                              limit === n ? 'border-pine-400 bg-pine-50 text-pine-700' : 'border-cream-300/60 hover:border-cream-400 text-bark-400'
                            )}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Model selector */}
                  {models.length > 0 && (
                    <div>
                      <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">LLM Model</label>
                      <div className="flex flex-wrap gap-2">
                        {models.map(m => {
                          const disabled = isModelDisabled(m.badge);
                          const disabledTitle = m.badge === 'No Key'
                            ? `Set ${m.provider.toUpperCase()}_API_KEY in environment to enable`
                            : 'Ollama only works when running the dev server locally';
                          return (
                            <button
                              key={m.id}
                              onClick={() => !disabled && setSelectedModel(m.id)}
                              disabled={disabled}
                              title={disabled ? disabledTitle : undefined}
                              className={cn(
                                'flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-sm font-medium transition-all',
                                disabled
                                  ? 'border-cream-200/40 text-bark-300 cursor-not-allowed opacity-50'
                                  : selectedModel === m.id
                                    ? 'border-pine-400 bg-pine-50 text-pine-700'
                                    : 'border-cream-300/60 hover:border-cream-400 text-bark-500'
                              )}
                            >
                              {m.label}
                              <span className={cn('text-xs px-1.5 py-0.5 rounded-md font-semibold', modelBadgeClass(m.badge, m.provider))}>
                                {m.badge}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {models.some(m => m.badge === 'Local Only') && (
                        <p className="text-xs text-bark-300 mt-1.5">Ollama models require the local dev server — use CLI crawl instead: <code className="font-mono bg-cream-200/60 px-1 rounded">npm run crawl</code></p>
                      )}
                    </div>
                  )}

                  {/* Discover toggle */}
                  <div>
                    <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">Options</label>
                    <button
                      onClick={() => setDiscover(d => !d)}
                      className={cn(
                        'flex items-center gap-2.5 w-full p-3 rounded-xl border text-left transition-all',
                        discover
                          ? 'border-pine-400 bg-pine-50 text-pine-700'
                          : 'border-cream-300/60 hover:border-cream-400 hover:bg-cream-100/60 text-bark-500'
                      )}
                    >
                      <Telescope className={cn('w-4 h-4 shrink-0', discover ? 'text-pine-500' : 'text-bark-300')} />
                      <div>
                        <p className="text-sm font-semibold leading-tight">Discover new programs</p>
                        <p className="text-xs opacity-70 mt-0.5">On listing pages with multiple camps, find and create new programs automatically</p>
                      </div>
                    </button>
                  </div>

                  {/* Priority preview list */}
                  {priority !== 'specific' && priority !== 'onboard_url' && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide">Preview</label>
                        <button onClick={fetchPreview} className="text-xs text-pine-500 hover:text-pine-600 flex items-center gap-1" disabled={previewLoading}>
                          <RefreshCw className={cn('w-3 h-3', previewLoading && 'animate-spin')} />
                          Refresh
                        </button>
                      </div>

                      {previewLoading ? (
                        <div className="flex items-center gap-2 py-4 text-bark-300 text-sm">
                          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                        </div>
                      ) : preview?.camps.length ? (
                        <div className="border border-cream-300/40 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                          {preview.camps.map((camp, i) => (
                            <div key={camp.id} className={cn('flex items-center gap-3 px-3 py-2 text-sm', i % 2 === 0 ? 'bg-white/30' : 'bg-cream-50/30')}>
                              <span className="text-bark-300 text-xs w-5 text-right shrink-0">{i + 1}</span>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-bark-600 truncate">{camp.name}</p>
                                <p className="text-xs text-bark-300">{camp.communitySlug}</p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0 text-xs">
                                <span className={cn('font-medium', CONFIDENCE_COLORS[camp.dataConfidence] ?? 'text-bark-300')}>{camp.dataConfidence}</span>
                                <span className="text-bark-300">{formatDate(camp.lastVerifiedAt)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-bark-300 text-sm py-3">No camps match this filter.</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-cream-300/40 bg-cream-50/30">
                  <p className="text-sm text-bark-400">
                    {priority === 'onboard_url'
                      ? (onboardUrl.trim() ? 'Will discover and crawl programs from that URL' : 'Enter a URL above to onboard a new site')
                      : crawlCamps.length > 0
                        ? `Will crawl ${crawlCamps.length} camp${crawlCamps.length !== 1 ? 's' : ''}`
                        : priority === 'specific' ? 'Search and select camps above' : 'Select a strategy to preview'}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={close} className="btn-secondary text-sm">Cancel</button>
                    <button
                      onClick={startCrawl}
                      disabled={priority === 'onboard_url' ? !onboardUrl.trim() : (!crawlCamps.length || previewLoading)}
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
