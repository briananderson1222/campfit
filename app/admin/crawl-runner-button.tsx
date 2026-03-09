'use client';

import { useState } from 'react';
import { Play, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type RunState = 'idle' | 'running' | 'done' | 'error';

interface Progress {
  processed: number;
  total: number;
  proposals: number;
  errors: number;
  current?: string;
}

export function CrawlRunnerButton() {
  const [state, setState] = useState<RunState>('idle');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const startCrawl = async () => {
    setState('running');
    setProgress({ processed: 0, total: 0, proposals: 0, errors: 0 });
    setErrorMsg(null);

    try {
      const res = await fetch('/api/admin/crawl/start', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start crawl');
      const { runId } = await res.json();

      const eventSource = new EventSource(`/api/admin/crawl/${runId}/status`);

      eventSource.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === 'started') {
          setProgress(p => ({ ...p!, total: event.totalCamps }));
        } else if (event.type === 'camp_processing') {
          setProgress(p => ({ ...p!, current: event.campName }));
        } else if (event.type === 'camp_done') {
          setProgress(p => ({
            ...p!,
            processed: p!.processed + 1,
            proposals: p!.proposals + (event.proposalId ? 1 : 0),
          }));
        } else if (event.type === 'camp_error') {
          setProgress(p => ({ ...p!, processed: p!.processed + 1, errors: p!.errors + 1 }));
        } else if (event.type === 'completed') {
          setState('done');
          eventSource.close();
        } else if (event.type === 'failed') {
          setState('error');
          setErrorMsg(event.error);
          eventSource.close();
        }
      };

      eventSource.onerror = () => {
        setState('error');
        setErrorMsg('Connection lost');
        eventSource.close();
      };
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  if (state === 'idle' || state === 'done' || state === 'error') {
    return (
      <div className="flex flex-col items-end gap-2">
        <button
          onClick={startCrawl}
          className={cn('btn-primary gap-2')}
        >
          <Play className="w-4 h-4" />
          Run Crawl
        </button>
        {state === 'done' && progress && (
          <p className="text-xs text-pine-600 flex items-center gap-1">
            <CheckCircle className="w-3.5 h-3.5" />
            Done · {progress.proposals} proposals · {progress.errors} errors
          </p>
        )}
        {state === 'error' && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <XCircle className="w-3.5 h-3.5" />
            {errorMsg}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-3 px-4 py-2 glass-panel">
        <Loader2 className="w-4 h-4 text-pine-500 animate-spin" />
        <div>
          <p className="text-sm font-medium text-bark-600">
            {progress?.processed ?? 0}/{progress?.total ?? '?'} camps
            {progress?.proposals ? ` · ${progress.proposals} changes` : ''}
            {progress?.errors ? ` · ${progress.errors} errors` : ''}
          </p>
          {progress?.current && (
            <p className="text-xs text-bark-300 truncate max-w-48">{progress.current}</p>
          )}
        </div>
      </div>
    </div>
  );
}
