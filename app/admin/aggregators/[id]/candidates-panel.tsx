'use client';

/**
 * app/admin/aggregators/[id]/candidates-panel.tsx — the curation screen
 * (campfit#93 R3/AC3, Wave 4 Task 4.2): dedupe status, per-candidate
 * provenance, multi-select onboard.
 *
 * Fetch-on-mount + `setState` shape mirrors `schedule-panel.tsx`
 * (`app/admin/crawls/schedule-panel.tsx`): a distinct loading/ready/error
 * `PanelState`, with the GET's response classified via a pure helper
 * (`classifyCandidatesLoad`, `./candidates-panel-view.ts`) so a non-2xx or
 * network-rejected response is never passed to `setState` as if it were
 * ready data (the same campfit#92 code-review HIGH-finding discipline that
 * file's own header doc explains). The dedupe badge follows
 * `app/admin/providers/page.tsx`'s badge/pill visual idiom
 * (`providers-table.tsx`'s pending-proposals pill); the provenance
 * disclosure follows `provider-review-panel.tsx`'s excerpt-quote-card idiom
 * (`app/admin/provider-review/[id]/provider-review-panel.tsx`'s
 * `diff.excerpt` rendering, amber quote card + external source link).
 *
 * Calls the Wave 4 Task 4.1 routes per the plan's declared contract:
 * `GET /api/admin/aggregators/[id]/candidates?status=PENDING` → candidate
 * rows; `POST /api/admin/aggregators/[id]/candidates/onboard` with
 * `{candidateIds}` → `{results: [...]}`. Both routes are owned by a
 * parallel worker and may not exist yet at authoring time; this component
 * is coded directly against the plan's contract (see
 * `candidates-panel-view.ts`'s header doc for the reconciliation note).
 *
 * This component's own interactivity (fetch/select/onboard) is the standing
 * campfit#96 accepted gap — no jsdom/testing-library harness exists in this
 * repo to render it. `tests/browser/aggregator-curation.spec.ts` records
 * that gap explicitly rather than silently omitting browser coverage.
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, Quote, XCircle } from 'lucide-react';
import { displayExternalUrl, safeExternalHref } from '@/lib/admin/safe-url';
import {
  classifyCandidatesLoad,
  classifyOnboardResponse,
  dedupeBadge,
  dedupeBadgeClassName,
  onboardResultCopy,
  snapshotSourceHref,
  truncateExcerpt,
  type AggregatorCandidateRow,
  type OnboardResultRow,
} from './candidates-panel-view';

type PanelState =
  | { status: 'loading' }
  | { status: 'ready'; candidates: AggregatorCandidateRow[] }
  | { status: 'error'; message: string };

export function CandidatesPanel({ aggregatorId }: { aggregatorId: string }) {
  const [panelState, setPanelState] = useState<PanelState>({ status: 'loading' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onboarding, setOnboarding] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, OnboardResultRow>>({});

  const load = useCallback(() => {
    let cancelled = false;
    setPanelState({ status: 'loading' });
    fetch(`/api/admin/aggregators/${aggregatorId}/candidates?status=PENDING`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        return classifyCandidatesLoad(r.ok ? { kind: 'ok', body } : { kind: 'http-error', status: r.status, body });
      })
      .catch(() => classifyCandidatesLoad({ kind: 'network-error' }))
      .then((result) => {
        if (cancelled) return;
        setPanelState(
          result.status === 'ready'
            ? { status: 'ready', candidates: result.candidates }
            : { status: 'error', message: result.message },
        );
      });
    return () => { cancelled = true; };
  }, [aggregatorId]);

  useEffect(() => load(), [load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onboardSelected() {
    if (selected.size === 0) return;
    setOnboarding(true);
    setOnboardError(null);
    try {
      const res = await fetch(`/api/admin/aggregators/${aggregatorId}/candidates/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateIds: Array.from(selected) }),
      });
      const body = await res.json().catch(() => null);
      const outcome = classifyOnboardResponse(res.ok ? { kind: 'ok', body } : { kind: 'http-error', status: res.status, body });
      if (outcome.status === 'error') {
        setOnboardError(outcome.message);
        return;
      }
      const byId: Record<string, OnboardResultRow> = {};
      for (const result of outcome.results) byId[result.candidateId] = result;
      setResults((prev) => ({ ...prev, ...byId }));
      // Only successfully onboarded candidates leave the selectable set —
      // an `error` result keeps its candidate selected for retry (per the
      // plan's Task 4.2 UX: "that candidate stays selectable for retry").
      setSelected((prev) => {
        const next = new Set(prev);
        for (const result of outcome.results) {
          if (result.status !== 'error') next.delete(result.candidateId);
        }
        return next;
      });
    } catch (err) {
      setOnboardError(err instanceof Error ? err.message : 'Failed to onboard selected candidates');
    } finally {
      setOnboarding(false);
    }
  }

  if (panelState.status === 'loading') {
    return (
      <div className="glass-panel p-4 flex items-center gap-2 text-bark-300 text-sm">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading candidates…
      </div>
    );
  }

  if (panelState.status === 'error') {
    return (
      <div className="glass-panel p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <XCircle className="w-5 h-5 text-red-400 shrink-0" />
          <p className="text-sm text-red-500">{panelState.message}</p>
        </div>
        <button onClick={load} className="btn-secondary text-sm">Try again</button>
      </div>
    );
  }

  const { candidates } = panelState;

  if (candidates.length === 0) {
    return (
      <div className="glass-panel p-10 text-center text-bark-300 text-sm">
        No pending candidates yet. Run discovery to populate this queue.
      </div>
    );
  }

  return (
    <div className="glass-panel overflow-hidden">
      <div className="px-5 py-4 border-b border-cream-300/60 flex items-center justify-between flex-wrap gap-3">
        <h2 className="font-display font-bold text-bark-700">
          Candidates
          <span className="ml-2 text-sm font-normal text-bark-400">({candidates.length} pending)</span>
        </h2>
        <button
          onClick={onboardSelected}
          disabled={onboarding || selected.size === 0}
          className="btn-primary text-sm gap-2 disabled:opacity-50"
        >
          {onboarding ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Onboard selected ({selected.size})
        </button>
      </div>

      {onboardError && (
        <p className="px-5 py-2 text-sm text-red-600 bg-red-50 border-b border-red-100">{onboardError}</p>
      )}

      <div className="divide-y divide-cream-200/60">
        {candidates.map((candidate) => {
          const badge = dedupeBadge(candidate);
          const excerpt = truncateExcerpt(candidate.provenanceExcerpt);
          const sourceHref = snapshotSourceHref(candidate.snapshotSourceRef);
          const safeSourceHref = sourceHref ? safeExternalHref(sourceHref) : undefined;
          const result = results[candidate.id];
          const websiteHref = candidate.websiteUrl ? safeExternalHref(candidate.websiteUrl) : undefined;

          return (
            <div key={candidate.id} className="px-5 py-4 flex items-start gap-3">
              <input
                type="checkbox"
                checked={selected.has(candidate.id)}
                onChange={() => toggle(candidate.id)}
                disabled={onboarding || (result != null && result.status !== 'error')}
                className="mt-1 w-4 h-4 accent-pine-600 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-bark-700 text-sm">{candidate.name}</span>
                  <span
                    title={badge.tooltip ?? undefined}
                    className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${dedupeBadgeClassName(badge.tone)}`}
                  >
                    {badge.label}
                  </span>
                  {candidate.locale && (
                    <span className="text-xs text-bark-400">{candidate.locale}</span>
                  )}
                </div>

                {websiteHref && (
                  <a
                    href={websiteHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-pine-500 hover:text-pine-700"
                  >
                    {displayExternalUrl(candidate.websiteUrl ?? '', 60)}
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                )}

                {excerpt && (
                  <div className="mt-2 flex items-start gap-2 bg-amber-50/60 border border-amber-200/60 rounded-lg px-3 py-2">
                    <Quote className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-amber-800 italic leading-relaxed">&quot;{excerpt}&quot;</p>
                      {safeSourceHref && (
                        <a
                          href={safeSourceHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 break-all text-xs text-pine-500 hover:text-pine-700"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          {displayExternalUrl(sourceHref ?? '', 70)}
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {result && (() => {
                  const copy = onboardResultCopy(result);
                  return (
                    <p className={`mt-2 text-xs ${result.status === 'error' ? 'text-red-600' : 'text-pine-600'}`}>
                      {copy.href ? (
                        <a href={copy.href} className="font-semibold underline">{copy.linkLabel}</a>
                      ) : (
                        copy.message
                      )}
                    </p>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
