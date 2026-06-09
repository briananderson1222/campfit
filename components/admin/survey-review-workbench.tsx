'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, Copy, ExternalLink, FileJson2, Fingerprint, GitBranch, Link2, Telescope } from 'lucide-react';
import type { ReviewSessionEvent } from '@kontourai/survey';

import {
  buildReviewItemPresentation,
  createPersistentReviewSessionEventStore,
  mountReviewWorkbench,
  type ReviewCandidatePresentation,
  type ReviewTraceRef,
} from '@/lib/kontourai/survey-review-workbench';
import type { CampReviewQueueSession } from '@/lib/admin/survey-review-items';
import { createCampSurveyPresentationAdapter, fieldNameForSurveyItem, sourceAuthorityLabel } from '@/lib/admin/survey-presentation';
import { cn } from '@/lib/utils';
import { adminTheme } from '@/components/admin/theme';
import { CampFieldValue } from '@/components/admin/camp-field-controls';

export function SurveyReviewWorkbench({
  session,
  eventPersistence,
  onPersistedEventsChange,
  fieldLabels = {},
}: {
  session: CampReviewQueueSession;
  eventPersistence?: {
    readonly proposalId: string;
    readonly initialEvents: readonly ReviewSessionEvent[];
  };
  onPersistedEventsChange?: (events: readonly ReviewSessionEvent[]) => void;
  fieldLabels?: Record<string, string>;
}) {
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const storageKey = `campfit:${session.items.map((item) => item.metadata.name).join(',')}`;
  const presentationAdapter = useMemo(() => createCampSurveyPresentationAdapter(fieldLabels), [fieldLabels]);

  useEffect(() => {
    if (!workbenchRef.current) return;
    mountReviewWorkbench(workbenchRef.current, session, {
      presentationAdapter,
      eventStore: eventPersistence
        ? createPersistentReviewSessionEventStore({
            initialEvents: eventPersistence.initialEvents,
            persist: async ({ events, expectedEventCount }) => {
              await persistProposalReviewEvents(eventPersistence.proposalId, events, expectedEventCount);
              onPersistedEventsChange?.(events);
            },
            onStatusChange: (state) => {
              setPersistenceError(state.status === 'error' ? 'Survey changes were not saved. Reload the review page before continuing.' : null);
            },
          })
        : createSessionStorageEventStore(storageKey),
    });
  }, [eventPersistence, onPersistedEventsChange, presentationAdapter, session, storageKey]);

  const activeItem = session.items.find((item) => item.metadata.name === session.activeItemName) ?? session.items[0];
  if (!activeItem) {
    return (
      <div className="rounded-xl border border-cream-300/70 bg-cream-50/80 p-3 text-xs text-bark-400 admin-surface">
        No Survey ReviewItems were generated for this proposal.
      </div>
    );
  }

  const presentation = buildReviewItemPresentation(activeItem, presentationAdapter);
  const current = presentation.candidates.find((candidate) => candidate.candidate.role === 'current');
  const proposed = presentation.candidates.find((candidate) => candidate.candidate.role === 'proposed');
  const labels = activeItem.metadata.labels ?? {};
  const fieldName = fieldNameForSurveyItem(activeItem);
  const campId = typeof labels.campId === 'string' ? labels.campId : undefined;
  const proposalId = typeof labels.proposalId === 'string' ? labels.proposalId : undefined;

  return (
    <section className="space-y-3" aria-label="Survey review workbench">
      <div className="overflow-hidden rounded-xl border border-pine-200/70 bg-white/80 admin-surface-raised">
        <div ref={workbenchRef} className="survey-workbench-embed theme-survey" />
      </div>

      {persistenceError && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-800" role="alert">
          {persistenceError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        <div className="rounded-xl border border-cream-300/70 bg-cream-50/80 p-4 admin-surface">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>Review field</p>
              <p className={cn('text-base font-semibold text-bark-700', adminTheme.textStrong)}>{presentation.targetLabel}</p>
              <p className={cn('mt-1 max-w-2xl text-xs leading-relaxed text-bark-400', adminTheme.textMuted)}>
                Survey is deciding which observed value should become the trusted CampFit value. Trace IDs are kept below for audit/debug, but the review should start with the value and source.
              </p>
            </div>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border dark:border-amber-300/30">
              {presentation.statusLabel}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Field label="CampFit field" value={fieldName} />
            <Field label="Actor" value={session.actorId} />
            <Field label="Items" value={String(session.items.length)} />
            <Field label="Reviewed at" value={new Date(session.reviewedAt).toLocaleString()} />
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            {campId && (
              <a
                href={`/admin/camps/${campId}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-cream-300/70 bg-white/75 px-2 py-1 text-[11px] font-semibold text-bark-500 hover:text-pine-700 admin-chip"
              >
                <ExternalLink className="h-3 w-3" />
                Camp record
              </a>
            )}
            {proposalId && <IdAffordance label="Proposal" value={proposalId} compact />}
          </div>
          <TraceDetails className="mt-3" refs={presentation.traceRefs} />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CandidateCard tone="current" presentation={current} fieldName={fieldName} />
          <CandidateCard tone="proposed" presentation={proposed} fieldName={fieldName} />
        </div>

        <div className="rounded-xl border border-pine-200/70 bg-pine-50/50 p-4 admin-surface">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-pine-700 admin-link">
            <Telescope className="h-3.5 w-3.5" />
            Projection summary
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            <ProjectionPill icon={<GitBranch className="h-3.5 w-3.5" />} label="Review set" value={`${session.items.length} field${session.items.length === 1 ? '' : 's'}`} />
            <ProjectionPill icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="If accepted">
              <CampFieldValue field={fieldName} value={proposed?.candidate.value} highlight />
            </ProjectionPill>
            <ProjectionPill icon={<Fingerprint className="h-3.5 w-3.5" />} label="Authority" value={sourceAuthorityLabel(proposed?.candidate.producer?.sourceAuthority)} />
          </div>
          <TraceDetails className="mt-3" refs={[
            ...presentation.traceRefs.filter((ref) => ref.kind === 'candidate-set'),
            { label: 'Proposed claim', value: proposed?.candidate.claimTarget.claimId ?? 'choose a candidate', kind: 'claim' },
          ]} />
        </div>
      </div>

      <details className="rounded-xl border border-cream-300/70 bg-cream-50/70 p-3 admin-surface">
        <summary className={cn('flex cursor-pointer items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-bark-400', adminTheme.textSubtle)}>
          <FileJson2 className="h-3.5 w-3.5" />
          Survey queue payload
        </summary>
        <pre className={cn('mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-bark-500', adminTheme.text)}>
          {JSON.stringify(session, null, 2)}
        </pre>
      </details>
    </section>
  );
}

function CandidateCard({
  tone,
  presentation,
  fieldName,
}: {
  tone: 'current' | 'proposed';
  presentation: ReviewCandidatePresentation | undefined;
  fieldName: string;
}) {
  if (!presentation) {
    return (
      <article className="rounded-xl border border-cream-300/70 bg-cream-50/70 p-3 text-xs text-bark-400 admin-surface">
        Missing {tone} candidate.
      </article>
    );
  }

  const isProposed = tone === 'proposed';
  const candidate = presentation.candidate;

  return (
    <article className={`rounded-xl border p-3 admin-surface-raised ${isProposed ? 'border-pine-200/80 bg-pine-50/40' : 'border-cream-300/80 bg-cream-50/70'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {isProposed ? <CheckCircle2 className="h-3.5 w-3.5 text-pine-600 admin-link" /> : <CircleDashed className="h-3.5 w-3.5 text-bark-300 admin-text-muted" />}
          <h4 className={cn('text-xs font-semibold uppercase tracking-wide text-bark-500', adminTheme.textSubtle)}>{presentation.roleLabel}</h4>
        </div>
        {candidate.confidence !== undefined && (
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-bark-500 admin-chip">
            {Math.round(candidate.confidence * 100)}%
          </span>
        )}
      </div>
      <p className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>{presentation.valueLabel}</p>
      <div className={cn('mb-2 mt-1 rounded-lg bg-white/70 p-2 text-sm font-medium text-bark-700 admin-surface', adminTheme.textStrong)}>
        <CampFieldValue field={fieldName} value={candidate.value} highlight={isProposed} expanded />
      </div>
      <dl className="space-y-2 text-xs">
        <SourceField text={presentation.sourceText} href={presentation.sourceLink?.href} />
        <Field label="Excerpt" value={candidate.locator?.excerpt ?? 'not provided'} />
      </dl>
      <TraceDetails className="mt-3" refs={presentation.traceRefs} />
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>{label}</dt>
      <dd className={cn('break-words text-bark-600', adminTheme.textStrong)}>{value}</dd>
    </div>
  );
}

function ProjectionPill({ icon, label, value, children }: { icon: React.ReactNode; label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-pine-200/60 bg-white/75 px-2.5 py-2 admin-surface">
      <p className={cn('flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>
        {icon}
        {label}
      </p>
      <div className={cn('mt-0.5 break-words font-medium text-bark-600', adminTheme.textStrong)}>{children ?? value}</div>
    </div>
  );
}

function TraceDetails({ refs, className }: { refs: readonly ReviewTraceRef[]; className?: string }) {
  return (
    <details className={cn('rounded-lg border border-cream-300/70 bg-white/60 px-3 py-2 admin-surface', className)}>
      <summary className={cn('cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>
        IDs and trace links
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        {refs.map((ref) => (
          <IdAffordance key={`${ref.label}:${ref.value}`} label={ref.label} value={ref.value} href={ref.link?.href} />
        ))}
      </div>
    </details>
  );
}

function SourceField({ text, href }: { text: string; href?: string }) {
  return (
    <div>
      <dt className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>Source</dt>
      {href ? (
        <dd>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 break-all text-bark-600 underline decoration-cream-400 underline-offset-2 hover:text-pine-700 admin-link"
          >
            <Link2 className="h-3 w-3 shrink-0" />
            {text}
          </a>
        </dd>
      ) : (
        <dd className={cn('break-words text-bark-600', adminTheme.textStrong)}>{text}</dd>
      )}
    </div>
  );
}

function IdAffordance({ label, value, href, compact = false, className }: { label: string; value: string; href?: string; compact?: boolean; className?: string }) {
  const canCopy = value && value !== 'not provided' && value !== 'choose a candidate';
  return (
    <div className={cn(compact ? 'inline-flex max-w-full items-center gap-1.5 rounded-full border border-cream-300/70 bg-white/75 px-2 py-1 admin-chip' : 'min-w-0', className)}>
      <span className={cn('text-[11px] text-bark-300', compact ? 'font-semibold' : 'block uppercase tracking-wide', adminTheme.textMuted)}>{label}</span>
      {href ? (
        <a href={href} className={cn('min-w-0 break-all font-mono text-[11px] text-pine-700 hover:underline admin-link')}>
          {value}
        </a>
      ) : (
        <span className={cn('min-w-0 break-all font-mono text-[11px] text-bark-500', adminTheme.text)}>{value}</span>
      )}
      {canCopy && (
        <button
          type="button"
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard?.writeText(value)}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-bark-300 hover:bg-cream-100 hover:text-pine-700"
        >
          <Copy className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function createSessionStorageEventStore(key: string) {
  return {
    load: () => {
      if (typeof window === 'undefined') return undefined;
      const value = window.sessionStorage.getItem(key);
      if (!value) return undefined;
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    save: (_session: unknown, events: readonly unknown[]) => {
      if (typeof window === 'undefined') return;
      window.sessionStorage.setItem(key, JSON.stringify(events));
    },
  };
}

async function persistProposalReviewEvents(
  proposalId: string,
  events: readonly ReviewSessionEvent[],
  expectedEventCount: number,
) {
  const response = await fetch(`/api/admin/review/${proposalId}/survey-events`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events, expectedEventCount }),
  });
  if (!response.ok) {
    throw new Error(`Failed to persist Survey review events: ${response.status}`);
  }
}
