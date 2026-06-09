'use client';

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, FileClock, GitCompareArrows, ListChecks } from 'lucide-react';
import type { ReviewSessionEvent } from '@kontourai/survey';
import {
  buildReviewWorkbenchSessionExportForSnapshot,
  validateReviewSessionEventsForSnapshot,
  type ReviewWorkbenchResult,
} from '@/lib/kontourai/survey-review-workbench';
import { cn } from '@/lib/utils';
import type { CampReviewQueueSession } from '@/lib/admin/survey-review-items';
import { adminTheme } from '@/components/admin/theme';

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
  const resultsByItemName = new Map(trail.results.map((result) => [result.reviewItemName, result]));
  const unresolvedItems = session.items.filter((item) => !resultsByItemName.has(item.metadata.name));

  return (
    <section
      className={cn('rounded-xl border border-pine-200/70 bg-pine-50/40 p-4 admin-surface', className)}
      data-testid="survey-review-trail"
      aria-label="Survey review trail"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileClock className="h-4 w-4 text-pine-600 admin-link" />
            <h3 className={cn('text-sm font-semibold uppercase tracking-wide text-bark-600', adminTheme.textStrong)}>Survey review trail</h3>
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-pine-700 admin-chip">
              Display-only replay
            </span>
          </div>
          <p className={cn('mt-1 max-w-3xl text-xs leading-relaxed text-bark-400', adminTheme.textMuted)}>
            This panel replays saved Survey events against the current proposal snapshot so reviewers can inspect the
            evidence trail before CampFit runs the same saved decisions on the server.
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
        <Metric icon={<Clock3 className="h-3.5 w-3.5" />} label="Reviewed" value={formatDate(session.reviewedAt)} />
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
              No saved Survey decisions yet. Choose candidates in the workbench below to build an auditable review trail.
            </div>
          ) : (
            trail.results.map((result) => (
              <TrailResult
                key={result.reviewItemName}
                result={result}
                item={session.items.find((candidate) => candidate.metadata.name === result.reviewItemName)}
                fieldLabels={fieldLabels}
              />
            ))
          )}

          {unresolvedItems.length > 0 && (
            <div className="rounded-xl border border-cream-300/70 bg-white/65 p-3 text-xs text-bark-400 admin-surface">
              <p className={cn('font-medium text-bark-500', adminTheme.text)}>{unresolvedItems.length} ReviewItem{unresolvedItems.length === 1 ? '' : 's'} still need a saved decision.</p>
              <p className="mt-1 break-words font-mono text-[11px]">{unresolvedItems.slice(0, 4).map((item) => item.metadata.name).join(', ')}</p>
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
  fieldLabels,
}: {
  result: ReviewWorkbenchResult;
  item?: CampReviewQueueSession['items'][number];
  fieldLabels: Record<string, string>;
}) {
  const target = item?.spec.target ?? result.reviewItemName;
  const label = fieldLabels[target] ?? target;
  const applyMeaning = result.selectedCandidateRole === 'proposed'
    ? 'Would apply proposed value'
    : 'Would keep current value';

  return (
    <article className="rounded-xl border border-pine-200/70 bg-white/75 p-3 admin-surface-raised" data-testid="survey-review-trail-result">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn('text-sm font-semibold text-bark-600', adminTheme.textStrong)}>{label}</p>
          <p className={cn('mt-0.5 break-words font-mono text-[11px] text-bark-300', adminTheme.textMuted)}>{result.reviewItemName}</p>
        </div>
        <span className="rounded-full bg-pine-100 px-2 py-0.5 text-[11px] font-semibold text-pine-700 admin-chip">
          {formatDecision(result.decision)}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
        <TrailField label="Selected candidate" value={result.selectedCandidateRole ?? result.selectedCandidateId} />
        <TrailField label="Selected value" value={result.selectedDisplayValue || formatValue(result.selectedValue)} />
        <TrailField label="Apply meaning" value={applyMeaning} />
      </div>
      {result.rationale && (
        <p className={cn('mt-2 rounded-lg bg-cream-50/80 px-2.5 py-2 text-xs leading-relaxed text-bark-500 admin-surface', adminTheme.text)}>
          {result.rationale}
        </p>
      )}
      {result.unselectedCandidates.length > 0 && (
        <p className={cn('mt-2 text-[11px] text-bark-300', adminTheme.textMuted)}>
          {result.unselectedCandidates.length} unselected candidate{result.unselectedCandidates.length === 1 ? '' : 's'} preserved in the trail.
        </p>
      )}
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

function TrailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>{label}</dt>
      <dd className={cn('break-words text-bark-600', adminTheme.textStrong)}>{value}</dd>
    </div>
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

function formatDecision(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return JSON.stringify(value);
}
