'use client';

/**
 * app/admin/aggregators/[id]/run-discovery-button.tsx — the "Run discovery"
 * affordance (campfit#93 R1/R2, Wave 4 Task 4.2).
 *
 * Mirrors `first-crawl-offer.tsx`'s idle→running→done/error state-machine
 * shape (`app/admin/providers/[providerId]/first-crawl-offer.tsx`).
 * Disabled with an explanatory title/tooltip whenever `tosApproved` is
 * false — this is DEFENSE IN DEPTH ONLY: the real gate is the repository
 * re-check inside `runAggregatorDiscovery`
 * (`lib/ingestion/aggregator/aggregator-extraction.ts`) and the route-level
 * 409 (`POST /api/admin/aggregators/[id]/discover`), both server-side and
 * both re-reading the aggregator row fresh rather than trusting this
 * component's own `tosApproved` prop — never the ONLY gate (see the plan's
 * AC1 dual-layer requirement).
 *
 * Calls `POST /api/admin/aggregators/[id]/discover` per the plan's declared
 * contract (`409 {error}` when unapproved with zero fetch calls; `200` with
 * an `AggregatorDiscoverySummary` when approved). That route (Wave 4 Task
 * 4.1) is owned by a parallel worker and may not exist yet at authoring
 * time; this component is coded directly against the plan's contract.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Telescope } from 'lucide-react';
import type { AggregatorDiscoverySummary } from '@/lib/ingestion/aggregator/aggregator-extraction';

type RunState = 'idle' | 'running' | 'done' | 'error';

export function RunDiscoveryButton({ aggregatorId, tosApproved }: { aggregatorId: string; tosApproved: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<RunState>('idle');
  const [summary, setSummary] = useState<AggregatorDiscoverySummary | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function runDiscovery() {
    if (!tosApproved) return;
    setState('running');
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/admin/aggregators/${aggregatorId}/discover`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setState('error');
        setErrorMsg(data?.error ?? 'Failed to run discovery');
        return;
      }
      setSummary(data as AggregatorDiscoverySummary);
      setState('done');
      router.refresh();
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to run discovery');
    }
  }

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Telescope className="w-5 h-5 text-pine-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-display font-bold text-bark-700">Run discovery</p>
            <p className="text-sm text-bark-400 mt-0.5">
              {tosApproved
                ? 'Crawl this aggregator and extract candidate providers for review.'
                : 'Blocked until a ToS decision of APPROVED is recorded above.'}
            </p>
          </div>
        </div>
        <button
          onClick={runDiscovery}
          disabled={!tosApproved || state === 'running'}
          title={tosApproved ? undefined : 'Record an APPROVED ToS decision to unlock discovery'}
          className="inline-flex items-center gap-2 rounded-xl bg-pine-600 px-4 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-pine-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {state === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Telescope className="w-4 h-4" />}
          {state === 'running' ? 'Running…' : 'Run discovery'}
        </button>
      </div>

      {state === 'done' && summary && (
        <div className="mt-4 text-sm text-bark-600 border-t border-cream-200/60 pt-3">
          Discovered {summary.discoveredCandidates} candidate{summary.discoveredCandidates !== 1 ? 's' : ''} across{' '}
          {summary.discoveredPages} page{summary.discoveredPages !== 1 ? 's' : ''} —{' '}
          {summary.enqueuedNew} new, {summary.enqueuedNearDuplicate} possible duplicate
          {summary.enqueuedNearDuplicate !== 1 ? 's' : ''}, {summary.skippedDuplicate} skipped as exact duplicates.
          {summary.pageErrors.length > 0 && (
            <span className="text-amber-600"> ({summary.pageErrors.length} page error{summary.pageErrors.length !== 1 ? 's' : ''})</span>
          )}
        </div>
      )}

      {state === 'error' && (
        <div className="mt-4 flex items-center gap-2 text-sm text-red-500">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {errorMsg ?? 'Discovery failed'}
        </div>
      )}
    </div>
  );
}
