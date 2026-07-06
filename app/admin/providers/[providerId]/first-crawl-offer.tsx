'use client';

// Guided first-crawl offer (campfit#90 R4/AC4) — UI-only, no backend changes.
// Wires the existing discover-mode `POST /api/admin/providers/{id}/crawl`
// (unmodified) and polls the existing `GET /api/admin/crawl/{runId}/status-json`
// (unmodified, same 3s-interval/5-minute-cap pattern as crawl-modal.tsx's
// onboard-url flow) then links into the existing `/admin/review?providerId=`
// filter (unmodified).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, Loader2, Telescope, XCircle } from 'lucide-react';

type OfferState = 'offer' | 'running' | 'done' | 'error' | 'dismissed';

export function FirstCrawlOffer({ providerId }: { providerId: string }) {
  const [state, setState] = useState<OfferState>('offer');
  const [progress, setProgress] = useState<{ processed: number; total: number; proposals: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (capRef.current) clearTimeout(capRef.current);
  }, []);

  async function runFirstCrawl() {
    setState('running');
    setProgress({ processed: 0, total: 0, proposals: 0 });
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/admin/providers/${providerId}/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discover: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState('error');
        setErrorMsg(data.error ?? 'Failed to start crawl');
        return;
      }

      const { runId } = data as { runId: string };
      const poll = setInterval(async () => {
        const r = await fetch(`/api/admin/crawl/${runId}/status-json`).catch(() => null);
        if (!r) return;
        const d = await r.json().catch(() => null);
        if (!d) return;
        setProgress({ processed: d.processedCamps ?? 0, total: d.totalCamps ?? 0, proposals: d.newProposals ?? 0 });
        if (d.status === 'COMPLETED') {
          clearInterval(poll);
          pollRef.current = null;
          setState('done');
        } else if (d.status === 'FAILED') {
          clearInterval(poll);
          pollRef.current = null;
          setState('error');
          setErrorMsg('Crawl failed');
        }
      }, 3000);
      pollRef.current = poll;

      capRef.current = setTimeout(() => {
        if (pollRef.current === poll) {
          clearInterval(poll);
          pollRef.current = null;
        }
      }, 310_000);
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Error');
    }
  }

  if (state === 'dismissed') return null;

  return (
    <div className="glass-panel p-5 border-pine-300/60 bg-pine-50/20">
      {state === 'offer' && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Telescope className="w-5 h-5 text-pine-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-display font-bold text-bark-700">Run a first crawl?</p>
              <p className="text-sm text-bark-400 mt-0.5">
                Discover programs from this provider&apos;s website and add them for review.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setState('dismissed')} className="btn-secondary text-sm">
              Skip for now
            </button>
            <button onClick={runFirstCrawl} className="btn-primary text-sm gap-2">
              <Telescope className="w-3.5 h-3.5" />
              Run first crawl now
            </button>
          </div>
        </div>
      )}

      {state === 'running' && (
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-pine-500 animate-spin shrink-0" />
          <p className="text-sm text-bark-600">
            Crawling{progress ? ` — ${progress.processed}/${progress.total || '?'} camps` : '…'}
            {progress && progress.proposals > 0 ? ` · ${progress.proposals} proposals found so far` : ''}
          </p>
        </div>
      )}

      {state === 'done' && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-5 h-5 text-pine-500 shrink-0" />
            <p className="text-sm font-medium text-bark-700">
              {progress?.proposals ?? 0} item{(progress?.proposals ?? 0) !== 1 ? 's' : ''} ready for review
            </p>
          </div>
          <Link href={`/admin/review?providerId=${providerId}`} className="btn-primary text-sm">
            Review items →
          </Link>
        </div>
      )}

      {state === 'error' && (
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <XCircle className="w-5 h-5 text-red-400 shrink-0" />
            <p className="text-sm text-red-500">{errorMsg ?? 'Crawl failed'}</p>
          </div>
          <button onClick={runFirstCrawl} className="btn-secondary text-sm">
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
