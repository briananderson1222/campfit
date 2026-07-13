'use client';

/**
 * app/admin/review/batch-accept-panel.tsx — the "Batch-ready" lane's
 * selection/batch-accept panel (campfit#51, Wave 3 Task 3.2, R1/R2/AC1/AC2).
 *
 * Renders the confidence-ranked, exact-corroborated `RankedProposal[]`
 * (`getRankedReviewQueue().batchReady`, loaded server-side by `page.tsx`),
 * with ONLY `corroboratedFieldChips`'s `selectable` chips checkable — this
 * is DEFENSE IN DEPTH ONLY (see `batch-accept-panel-view.ts`'s own comment):
 * the real gates are `applyBatchAcceptedClaims`'s server-side corroboration
 * re-derivation and the route's per-selection community-scope re-check,
 * both independent of this component's own state.
 *
 * State-machine shape mirrors `run-discovery-button.tsx`'s
 * idle→running→done/error idiom. Calls `POST /api/admin/review/batch-accept`
 * per the route's declared contract (`{selections}` → `{auditId, results}`),
 * classified via the pure `classifyBatchAcceptResponse`
 * (`./batch-accept-panel-view.ts`) so a non-2xx or network-rejected response
 * is never passed to `setState` as if it were ready data (the same
 * campfit#92 code-review HIGH-finding discipline `candidates-panel.tsx`
 * already follows). After a successful submit, `router.refresh()` reloads
 * the server-rendered lanes — some proposals fully approve (disappear from
 * this lane entirely) or partially approve (fewer remaining chips), so the
 * page's own re-fetch of `getRankedReviewQueue` is the source of truth, not
 * client-side state patching.
 *
 * This component's own interactivity (checkbox/submit/outcome rendering) is
 * the standing campfit#96 accepted gap — no jsdom/testing-library harness
 * exists in this repo to render it interactively.
 * `tests/browser/review-batch-accept.spec.ts` records that gap explicitly.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ExternalLink, Loader2, Quote, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RankedProposal } from '@/lib/admin/review-repository';
import {
  batchAcceptResultCopy,
  classifyBatchAcceptResponse,
  corroboratedFieldChips,
  type BatchAcceptResultRow,
} from './batch-accept-panel-view';
import { TrustBadge } from '@/components/trust-badge';
import { ShadowAutoAcceptBadge } from '@/components/admin/shadow-auto-accept-badge';

type SubmitState = 'idle' | 'running' | 'done' | 'error';

function selectionKey(proposalId: string, field: string): string {
  return `${proposalId}::${field}`;
}

export function BatchAcceptPanel({ proposals }: { proposals: RankedProposal[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<SubmitState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, BatchAcceptResultRow>>({});

  function toggle(proposalId: string, field: string) {
    const key = selectionKey(proposalId, field);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submitBatch() {
    if (selected.size === 0) return;
    setState('running');
    setErrorMsg(null);
    try {
      const selections = Array.from(selected).map((key) => {
        const [proposalId, field] = key.split('::');
        return { proposalId, field };
      });
      const res = await fetch('/api/admin/review/batch-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections }),
      });
      const body = await res.json().catch(() => null);
      const outcome = classifyBatchAcceptResponse(res.ok ? { kind: 'ok', body } : { kind: 'http-error', status: res.status, body });
      if (outcome.status === 'error') {
        setState('error');
        setErrorMsg(outcome.message);
        return;
      }

      const byKey: Record<string, BatchAcceptResultRow> = {};
      for (const result of outcome.results) byKey[selectionKey(result.proposalId, result.field)] = result;
      setResults(byKey);
      setSelected(new Set());
      setState('done');
      router.refresh();
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to submit batch accept');
    }
  }

  if (proposals.length === 0) {
    return (
      <div className="glass-panel p-10 text-center text-bark-300 text-sm">
        No batch-ready proposals right now — corroborated field claims will appear here as crawls agree with each other.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 glass-panel px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-bark-500">
          Select exact-corroborated field claims below, then batch-accept them in one action.
        </p>
        <button
          onClick={submitBatch}
          disabled={state === 'running' || selected.size === 0}
          className="btn-primary text-sm gap-2 disabled:opacity-50 shrink-0"
        >
          {state === 'running' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Batch accept ({selected.size} selected)
        </button>
      </div>

      {state === 'error' && errorMsg && (
        <div className="glass-panel px-5 py-3 flex items-center gap-2 text-sm text-red-500">
          <XCircle className="w-4 h-4 shrink-0" />
          {errorMsg}
        </div>
      )}

      {proposals.map((proposal) => {
        const changeCount = Object.keys(proposal.proposedChanges).length;
        const chips = corroboratedFieldChips(proposal);
        return (
          <div key={proposal.id} className="glass-panel p-5">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-bark-700 truncate">{proposal.campName}</h3>
              <span className="text-xs text-bark-300 shrink-0">{proposal.communitySlug}</span>
              <ShadowAutoAcceptBadge show={proposal.shadowAutoAccept} />
              <span className="ml-auto text-xs font-semibold text-pine-600 shrink-0">
                {Math.round(proposal.overallConfidence * 100)}%
              </span>
            </div>
            <p className="text-xs text-bark-400 mb-2">
              {changeCount} field{changeCount !== 1 ? 's' : ''} changed
            </p>
            <div className="space-y-1.5">
              {chips.map((chip) => {
                const key = selectionKey(proposal.id, chip.field);
                const result = results[key];
                return (
                  <div key={chip.field} className="rounded-lg border border-cream-300/60 bg-cream-50/50 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <label
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs',
                          chip.selectable ? 'bg-pine-50 text-pine-700 border border-pine-200/60' : 'bg-cream-100 text-bark-400',
                        )}
                      >
                        {chip.selectable && (
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggle(proposal.id, chip.field)}
                            disabled={state === 'running' || (result != null && result.status === 'applied')}
                            className="w-3.5 h-3.5 accent-pine-600"
                          />
                        )}
                        {chip.field}
                        {result && (
                          result.status === 'applied'
                            ? <CheckCircle2 className="w-3 h-3 text-pine-600" />
                            : <XCircle className="w-3 h-3 text-red-400" />
                        )}
                      </label>
                      <span className="text-[11px] font-semibold text-bark-400">
                        {Math.round(chip.confidence * 100)}% confidence
                      </span>
                      {chip.sourceHost && (
                        chip.sourceHref ? (
                          <a
                            href={chip.sourceHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-pine-600 hover:text-pine-700"
                          >
                            {chip.sourceHost}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-[11px] text-bark-300">{chip.sourceHost}</span>
                        )
                      )}
                    </div>
                    <details className="mt-1.5 text-xs text-bark-400">
                      <summary className="cursor-pointer select-none text-[11px] font-semibold text-bark-400 hover:text-pine-600">
                        Evidence{chip.excerptPreview ? ` — “${chip.excerptPreview}”` : ' — no excerpt provided'}
                      </summary>
                      <div className="mt-2 flex items-start gap-1.5 rounded-md bg-white/70 px-2.5 py-2">
                        <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <p className="italic leading-relaxed">
                          {chip.excerpt ? `“${chip.excerpt}”` : 'No source excerpt was provided for this field.'}
                        </p>
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
            {Object.entries(results)
              .filter(([resultKey]) => resultKey.startsWith(`${proposal.id}::`))
              .map(([resultKey, result]) => (
                <div key={resultKey} className={cn('mt-1.5 text-xs flex flex-wrap items-center gap-2', result.status === 'applied' ? 'text-pine-600' : 'text-red-500')}>
                  <span>{result.field}: {batchAcceptResultCopy(result)}</span>
                  {result.receipt && <TrustBadge camp={{ dataConfidence: 'UNVERIFIED', lastVerifiedAt: null } as never} display={result.receipt} />}
                  {result.receipt?.actor && <span>{[result.receipt.actor, result.receipt.at, result.receipt.reason].filter(Boolean).join(' · ')}</span>}
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
