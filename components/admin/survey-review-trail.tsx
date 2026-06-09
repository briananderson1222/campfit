'use client';

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Copy, FileClock, GitCompareArrows, ListChecks } from 'lucide-react';
import type { ReviewSessionEvent } from '@kontourai/survey';
import {
  buildReviewResultPresentation,
  buildReviewWorkbenchSessionExportForSnapshot,
  validateReviewSessionEventsForSnapshot,
  type ReviewWorkbenchResult,
  type ReviewTraceRef,
} from '@/lib/kontourai/survey-review-workbench';
import { cn } from '@/lib/utils';
import type { CampReviewQueueSession } from '@/lib/admin/survey-review-items';
import { createCampSurveyPresentationAdapter, fieldNameForSurveyItem, formatSurveyDate } from '@/lib/admin/survey-presentation';
import { adminTheme } from '@/components/admin/theme';
import { CampFieldValue } from '@/components/admin/camp-field-controls';

export function SurveyReviewTrail({
  session,
  events,
  fieldLabels = {},
  className,
}: {
  session: CampReviewQueueSession;
  events: readonly ReviewSessionEvent[];
  fieldLabels?: Record<string, string>;
  className?: string;
}) {
  const trail = useMemo(() => buildSurveyReviewTrail(session, events), [session, events]);
  const presentationAdapter = useMemo(() => createCampSurveyPresentationAdapter(fieldLabels), [fieldLabels]);
  const resultsByItemName = new Map(trail.results.map((result) => [result.reviewItemName, result]));
  const unresolvedItems = session.items.filter((item) => !resultsByItemName.has(item.metadata.name));

  return (
    <section
      className={cn('rounded-xl border border-cream-300/70 bg-white/80 p-4 admin-surface-raised', className)}
      data-testid="survey-review-trail"
      aria-label="Saved Survey decisions"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-pine-600 admin-link" />
            <h3 className={cn('text-sm font-semibold uppercase tracking-wide text-bark-600', adminTheme.textStrong)}>Saved Survey decisions</h3>
            <span className="rounded-full bg-pine-100 px-2 py-0.5 text-[11px] font-semibold text-pine-700 admin-chip">
              Replay checked
            </span>
          </div>
          <p className={cn('mt-1 max-w-3xl text-xs leading-relaxed text-bark-400', adminTheme.textMuted)}>
            These are the decisions already saved for this proposal. CampFit replays the same Survey events on the server before applying field updates.
          </p>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-white/75 px-2.5 py-1 text-xs font-semibold text-bark-500 admin-chip">
          {trail.issues.length > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-pine-600" />
          )}
          {trail.issues.length > 0 ? 'Snapshot mismatch' : 'Snapshot matched'}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric icon={<ListChecks className="h-3.5 w-3.5" />} label="Resolved" value={`${trail.results.length}/${session.items.length}`} />
        <Metric icon={<GitCompareArrows className="h-3.5 w-3.5" />} label="Events" value={String(events.length)} />
        <Metric icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Decisions" value={String(trail.decisions.length)} />
        <Metric icon={<Clock3 className="h-3.5 w-3.5" />} label="Reviewed" value={formatSurveyDate(session.reviewedAt)} />
      </dl>

      {trail.issues.length > 0 ? (
        <div
          className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800"
          data-testid="survey-review-trail-issues"
          role="alert"
        >
          <p className="font-semibold">Saved Survey events no longer replay cleanly for this proposal snapshot.</p>
          <ul className="mt-2 space-y-1">
            {trail.issues.slice(0, 3).map((issue) => (
              <li key={`${issue.eventName}-${issue.sequence}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {trail.results.length === 0 ? (
            <div className="rounded-xl border border-cream-300/70 bg-white/70 p-3 text-xs text-bark-400 admin-surface" data-testid="survey-review-trail-empty">
              No saved Survey decisions yet. Choose candidates in the workbench below to build an auditable review record.
            </div>
          ) : (
            trail.results.map((result) => (
              <TrailResult
                key={result.reviewItemName}
                result={result}
                item={session.items.find((candidate) => candidate.metadata.name === result.reviewItemName)}
                presentationAdapter={presentationAdapter}
              />
            ))
          )}

          {unresolvedItems.length > 0 && (
            <div className="rounded-xl border border-cream-300/70 bg-white/65 p-3 text-xs text-bark-400 admin-surface">
              <p className={cn('font-medium text-bark-500', adminTheme.text)}>{unresolvedItems.length} field{unresolvedItems.length === 1 ? '' : 's'} still need a saved decision.</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unresolvedItems.slice(0, 4).map((item) => (
                  <span key={item.metadata.name} className="rounded-full border border-cream-300/70 bg-white/75 px-2 py-0.5 text-[11px] font-semibold text-bark-500 admin-chip">
                    {presentationAdapter.labelForTarget?.(item.spec.target, { item }) ?? item.spec.target}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TrailResult({
  result,
  item,
  presentationAdapter,
}: {
  result: ReviewWorkbenchResult;
  item?: CampReviewQueueSession['items'][number];
  presentationAdapter: ReturnType<typeof createCampSurveyPresentationAdapter>;
}) {
  const presentation = buildReviewResultPresentation(result, item, presentationAdapter);
  const target = item ? fieldNameForSurveyItem(item) : presentation.target;
  const currentCandidate = item?.spec.candidates.find((candidate) => candidate.role === 'current');
  const proposedCandidate = item?.spec.candidates.find((candidate) => candidate.role === 'proposed');
  const campId = typeof item?.metadata.labels?.campId === 'string' ? item.metadata.labels.campId : undefined;

  return (
    <article className="rounded-lg border border-cream-300/70 bg-white/75 p-3 admin-surface-raised" data-testid="survey-review-trail-result">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn('text-sm font-semibold text-bark-600', adminTheme.textStrong)}>{presentation.targetLabel}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {campId && (
              <a href={`/admin/camps/${campId}`} className="text-[11px] font-semibold text-pine-700 hover:underline admin-link">
                Camp record
              </a>
            )}
          </div>
        </div>
        <span className="rounded-full bg-pine-100 px-2 py-0.5 text-[11px] font-semibold text-pine-700 admin-chip">
          {presentation.decisionLabel}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
        <DecisionPill label="Current" muted={result.selectedCandidateRole !== 'current'}>
          <CampFieldValue field={target} value={currentCandidate?.value} expanded />
        </DecisionPill>
        <DecisionPill label="Proposed" muted={result.selectedCandidateRole !== 'proposed'}>
          <CampFieldValue field={target} value={proposedCandidate?.value} highlight={result.selectedCandidateRole === 'proposed'} expanded />
        </DecisionPill>
        <DecisionPill label="Saved selection">
          <CampFieldValue field={target} value={result.selectedValue} highlight expanded />
        </DecisionPill>
      </div>
      <p className={cn('mt-2 text-xs font-medium text-bark-500', adminTheme.text)}>
        {presentation.applyMeaning} <span className="sr-only">Would apply proposed value</span>
      </p>
      {result.rationale && (
        <p className={cn('mt-2 rounded-lg bg-cream-50/80 px-2.5 py-2 text-xs leading-relaxed text-bark-500 admin-surface', adminTheme.text)}>
          {result.rationale}
        </p>
      )}
      {result.unselectedCandidates.length > 0 && (
        <p className={cn('mt-2 text-[11px] text-bark-300', adminTheme.textMuted)}>
          {result.unselectedCandidates.length} unselected candidate{result.unselectedCandidates.length === 1 ? '' : 's'} preserved for audit.
        </p>
      )}
      <TraceDetails refs={presentation.traceRefs} />
    </article>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-cream-300/70 bg-white/70 p-3 admin-surface-raised">
      <dt className={cn('flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>
        {icon}
        {label}
      </dt>
      <dd className={cn('mt-1 break-words text-sm font-semibold text-bark-600', adminTheme.textStrong)}>{value}</dd>
    </div>
  );
}

function DecisionPill({ label, children, muted = false }: { label: string; children: ReactNode; muted?: boolean }) {
  return (
    <div className={cn('rounded-lg border px-2.5 py-2 admin-surface', muted ? 'border-cream-300/60 bg-cream-50/60' : 'border-pine-200/70 bg-pine-50/60')}>
      <dt className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>{label}</dt>
      <dd className={cn('mt-0.5 break-words font-medium', muted ? 'text-bark-400' : 'text-bark-700', muted ? adminTheme.textMuted : adminTheme.textStrong)}>
        {children}
      </dd>
    </div>
  );
}

function TraceDetails({ refs }: { refs: readonly ReviewTraceRef[] }) {
  return (
    <details className="mt-3 rounded-lg border border-cream-300/70 bg-cream-50/70 px-3 py-2 admin-surface">
      <summary className={cn('cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>
        IDs and trace links
      </summary>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {refs.map((ref) => (
          <InlineId key={`${ref.label}:${ref.value}`} refItem={ref} />
        ))}
      </div>
    </details>
  );
}

function InlineId({ refItem }: { refItem: ReviewTraceRef }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-cream-300/70 bg-white/70 px-2 py-0.5 admin-chip">
      <span className={cn('shrink-0 text-[11px] font-semibold text-bark-300', adminTheme.textMuted)}>{refItem.label}</span>
      <span className={cn('min-w-0 break-all font-mono text-[11px] text-bark-500', adminTheme.text)}>{refItem.value}</span>
      <button
        type="button"
        title={`Copy ${refItem.label}`}
        aria-label={`Copy ${refItem.label}`}
        onClick={() => void navigator.clipboard?.writeText(refItem.value)}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-bark-300 hover:bg-cream-100 hover:text-pine-700"
      >
        <Copy className="h-3 w-3" />
      </button>
    </span>
  );
}

function buildSurveyReviewTrail(session: CampReviewQueueSession, events: readonly ReviewSessionEvent[]) {
  const issues = validateReviewSessionEventsForSnapshot(session, events);
  if (issues.length > 0) {
    return {
      issues,
      decisions: [],
      results: [],
    };
  }

  const sessionExport = buildReviewWorkbenchSessionExportForSnapshot(session, events);
  return {
    issues: [],
    decisions: sessionExport.decisions,
    results: sessionExport.results,
  };
}
