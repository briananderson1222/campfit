'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ChevronDown, ChevronUp, CheckCircle, XCircle, Minus,
  ExternalLink, RefreshCw, Loader2, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CrawlRun, CrawlCampLogEntry } from '@/lib/admin/types';

function durationLabel(startedAt: string, completedAt: string | null, isRunning = false): string {
  const end = isRunning ? Date.now() : (completedAt ? new Date(completedAt).getTime() : Date.now());
  const ms = end - new Date(startedAt).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    COMPLETED: 'bg-pine-100 text-pine-700',
    FAILED:    'bg-red-100 text-red-600',
    RUNNING:   'bg-amber-100 text-amber-700',
  };
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold',
      styles[status] ?? 'bg-cream-200 text-bark-400'
    )}>
      {status === 'RUNNING' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {status}
    </span>
  );
}

function CampLogRow({ entry }: { entry: CrawlCampLogEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn(
      'border-b border-cream-200/40 last:border-0',
      entry.status === 'error' ? 'bg-red-50/40' : entry.status === 'no_changes' ? '' : 'bg-pine-50/20'
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-cream-100/40 transition-colors"
      >
        {entry.status === 'ok'
          ? <CheckCircle className="w-3.5 h-3.5 text-pine-500 shrink-0" />
          : entry.status === 'error'
          ? <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          : <Minus className="w-3.5 h-3.5 text-bark-300 shrink-0" />}

        <span className="flex-1 font-medium text-bark-600 truncate">{entry.campName}</span>
        <span className="text-xs text-bark-300 shrink-0">{Math.round(entry.durationMs / 1000)}s</span>

        {entry.fieldsChanged.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 bg-pine-100 text-pine-700 rounded-md font-medium shrink-0">
            {entry.fieldsChanged.length} field{entry.fieldsChanged.length !== 1 ? 's' : ''}
          </span>
        )}

        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-bark-300 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-bark-300 shrink-0" />}
      </button>

      {expanded && (
        <div className="px-8 pb-3 space-y-1.5">
          <a href={entry.url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-pine-500 hover:text-pine-600 flex items-center gap-1 truncate max-w-xs">
            <ExternalLink className="w-3 h-3 shrink-0" />
            {entry.url}
          </a>
          <p className="text-xs text-bark-300">Model: {entry.model}</p>

          {entry.fieldsChanged.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {entry.fieldsChanged.map(f => (
                <span key={f} className="text-xs px-1.5 py-0.5 bg-pine-50 border border-pine-200 text-pine-700 rounded">
                  {f}
                </span>
              ))}
            </div>
          )}

          {entry.error && (
            <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded px-2 py-1 mt-1">
              {entry.error}
            </p>
          )}

          {entry.status === 'no_changes' && (
            <p className="text-xs text-bark-300">No changes detected — data looks current</p>
          )}
        </div>
      )}
    </div>
  );
}

interface RunWithLog extends CrawlRun {
  campLog: CrawlCampLogEntry[];
}

function CrawlRunCard({ run: initialRun, highlight }: { run: RunWithLog; highlight: boolean }) {
  const [run, setRun] = useState(initialRun);
  const [expanded, setExpanded] = useState(highlight || initialRun.status === 'RUNNING');
  const [elapsed, setElapsed] = useState(() => durationLabel(initialRun.startedAt, initialRun.completedAt, initialRun.status === 'RUNNING'));

  // Poll DB for live progress when running
  useEffect(() => {
    if (run.status !== 'RUNNING') return;
    const interval = setInterval(async () => {
      const r = await fetch(`/api/admin/crawl/${run.id}/status-json`).catch(() => null);
      if (!r) return;
      const data = await r.json().catch(() => null);
      if (!data) return;
      setRun(prev => ({ ...prev, ...data }));
      if (data.status !== 'RUNNING') clearInterval(interval);
    }, 3000);
    return () => clearInterval(interval);
  }, [run.id, run.status]);

  // Tick elapsed timer for running runs
  useEffect(() => {
    if (run.status !== 'RUNNING') return;
    const t = setInterval(() => setElapsed(durationLabel(run.startedAt, null, true)), 1000);
    return () => clearInterval(t);
  }, [run.startedAt, run.status]);

  // Update elapsed when completed
  useEffect(() => {
    if (run.status !== 'RUNNING') {
      setElapsed(durationLabel(run.startedAt, run.completedAt, false));
    }
  }, [run.status, run.startedAt, run.completedAt]);

  const progress = run.totalCamps > 0 ? (run.processedCamps / run.totalCamps) * 100 : 0;

  return (
    <div
      id={run.id}
      className={cn('glass-panel overflow-hidden', highlight && 'border-pine-300/60 bg-pine-50/20')}
    >
      {/* Live progress bar */}
      {run.status === 'RUNNING' && (
        <div className="h-1 bg-cream-200/60">
          <div className="h-full bg-pine-400 transition-all duration-1000" style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex-1 flex items-start gap-3 text-left min-w-0"
          >
            <StatusBadge status={run.status} />

            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-bark-700">
                {run.totalCamps > 0
                  ? `${run.processedCamps} / ${run.totalCamps} camps`
                  : run.status === 'RUNNING' ? 'Starting…' : 'No camps'}
                {run.newProposals > 0 && <span className="text-pine-600 font-normal ml-2">· {run.newProposals} proposals</span>}
                {run.errorCount > 0 && <span className="text-red-500 font-normal ml-2">· {run.errorCount} errors</span>}
              </p>
              <p className="text-xs text-bark-300 mt-0.5 flex items-center gap-1.5 flex-wrap">
                <Clock className="w-3 h-3" />
                {elapsed}
                <span>·</span>
                {new Date(run.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                <span>·</span>
                {run.trigger}
                {run.triggeredBy && <><span>·</span>{run.triggeredBy}</>}
              </p>
            </div>

            {expanded
              ? <ChevronUp className="w-4 h-4 text-bark-300 mt-0.5 shrink-0" />
              : <ChevronDown className="w-4 h-4 text-bark-300 mt-0.5 shrink-0" />}
          </button>

          {run.newProposals > 0 && (
            <Link href="/admin/review"
              className="text-xs px-2 py-1 bg-amber-100 text-amber-700 rounded-lg font-medium hover:bg-amber-200 transition-colors shrink-0">
              Review →
            </Link>
          )}
        </div>

        {/* Camp log */}
        {expanded && (
          <div className="mt-4 border border-cream-300/40 rounded-xl overflow-hidden">
            {run.campLog.length > 0 ? (
              <>
                <div className="px-3 py-1.5 bg-cream-100/60 border-b border-cream-200/40 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs font-semibold text-bark-400 uppercase tracking-wide">
                    Camp Log ({run.campLog.length}{run.status === 'RUNNING' ? ` / ${run.totalCamps}` : ''})
                  </span>
                  <div className="flex items-center gap-2 text-xs text-bark-300">
                    <span className="text-pine-600 font-medium">{run.campLog.filter(e => e.status === 'ok').length} changed</span>
                    <span>·</span>
                    <span>{run.campLog.filter(e => e.status === 'no_changes').length} unchanged</span>
                    {run.campLog.filter(e => e.status === 'error').length > 0 && (
                      <><span>·</span><span className="text-red-500 font-medium">{run.campLog.filter(e => e.status === 'error').length} errors</span></>
                    )}
                  </div>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {run.campLog.map((entry, i) => <CampLogRow key={i} entry={entry} />)}
                  {run.status === 'RUNNING' && run.campLog.length < run.totalCamps && (
                    <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-bark-300 border-t border-cream-200/40">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Processing camp {run.campLog.length + 1} of {run.totalCamps}…
                    </div>
                  )}
                </div>
              </>
            ) : run.status === 'RUNNING' ? (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-bark-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Waiting for first camp to complete…
              </div>
            ) : (
              <p className="px-3 py-4 text-xs text-bark-300">No camp log for this run (ran before logging was added).</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminCrawlsPage({
  searchParams,
}: {
  searchParams: { runId?: string };
}) {
  const [runs, setRuns] = useState<RunWithLog[]>([]);
  const [loading, setLoading] = useState(true);
  const highlightId = searchParams.runId;

  const fetchRuns = useCallback(async () => {
    const r = await fetch('/api/admin/crawl/list').catch(() => null);
    if (!r) return;
    const data = await r.json().catch(() => null);
    if (data?.runs) setRuns(data.runs);
    setLoading(false);
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // Refresh list when any run completes (in case new ones started elsewhere)
  useEffect(() => {
    const hasRunning = runs.some(r => r.status === 'RUNNING');
    if (!hasRunning) return;
    const interval = setInterval(fetchRuns, 15_000);
    return () => clearInterval(interval);
  }, [runs, fetchRuns]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Crawl Monitor</h1>
          <p className="text-bark-400 text-sm mt-1">
            Last 50 runs · live progress for active crawls · click to expand camp log
          </p>
        </div>
        <button onClick={fetchRuns} className="btn-secondary text-sm gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 text-bark-300 py-16">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : runs.length === 0 ? (
        <div className="glass-panel p-16 text-center">
          <p className="text-bark-300 text-lg">No crawl runs yet</p>
          <p className="text-bark-200 text-sm mt-2">Start a crawl from the dashboard</p>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map(run => (
            <CrawlRunCard key={run.id} run={run} highlight={run.id === highlightId} />
          ))}
        </div>
      )}
    </div>
  );
}
