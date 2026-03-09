'use client';

import { useState } from 'react';
import { RefreshCw, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type State = 'idle' | 'running' | 'done' | 'error';

export function RecrawlButton({ campId, campName }: { campId: string; campName: string }) {
  const [state, setState] = useState<State>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    setState('running');
    setMsg(null);
    try {
      const res = await fetch('/api/admin/crawl/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campIds: [campId] }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { runId } = await res.json();

      // Poll for completion
      const poll = setInterval(async () => {
        const r = await fetch(`/api/admin/crawl/${runId}/status-json`).catch(() => null);
        if (!r) return;
        const data = await r.json().catch(() => null);
        if (!data) return;
        if (data.status === 'COMPLETED') {
          clearInterval(poll);
          setState('done');
          setMsg(`${data.newProposals ?? 0} proposals`);
        } else if (data.status === 'FAILED') {
          clearInterval(poll);
          setState('error');
          setMsg('Crawl failed');
        }
      }, 3000);

      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(poll);
        if (state === 'running') {
          setState('error');
          setMsg('Timed out');
        }
      }, 300_000);
    } catch (err) {
      setState('error');
      setMsg(err instanceof Error ? err.message : 'Error');
    }
  };

  if (state === 'running') {
    return (
      <span className="flex items-center gap-1 text-xs text-pine-500">
        <Loader2 className="w-3 h-3 animate-spin" />
        Crawling…
      </span>
    );
  }

  if (state === 'done') {
    return (
      <span className="flex items-center gap-1 text-xs text-pine-600">
        <CheckCircle className="w-3 h-3" />
        {msg}
      </span>
    );
  }

  if (state === 'error') {
    return (
      <button
        onClick={run}
        className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
        title={msg ?? 'Error — click to retry'}
      >
        <XCircle className="w-3 h-3" />
        Retry
      </button>
    );
  }

  return (
    <button
      onClick={run}
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors',
        'text-bark-400 hover:text-pine-600 hover:bg-pine-50'
      )}
      title={`Recrawl ${campName}`}
    >
      <RefreshCw className="w-3 h-3" />
      Crawl
    </button>
  );
}
