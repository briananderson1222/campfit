'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, Copy, ExternalLink, FileJson2, Fingerprint, GitBranch, Link2, Telescope } from 'lucide-react';
import type { ReviewSessionEvent } from '@kontourai/survey';

import { createPersistentReviewSessionEventStore, mountReviewWorkbench } from '@/lib/kontourai/survey-review-workbench';
import type { CampReviewQueueSession } from '@/lib/admin/survey-review-items';
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

  useEffect(() => {
    if (!workbenchRef.current) return;
    mountReviewWorkbench(workbenchRef.current, session, {
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
  }, [eventPersistence, onPersistedEventsChange, session, storageKey]);

  const activeItem = session.items.find((item) => item.metadata.name === session.activeItemName) ?? session.items[0];
  if (!activeItem) {
    return (
      <div className="rounded-xl border border-cream-300/70 bg-cream-50/80 p-3 text-xs text-bark-400 admin-surface">
        No Survey ReviewItems were generated for this proposal.
      </div>
    );
  }

  const current = activeItem.spec.candidates.find((candidate) => candidate.role === 'current');
  const proposed = activeItem.spec.candidates.find((candidate) => candidate.role === 'proposed');
  const labels = activeItem.metadata.labels ?? {};
  const fieldName = typeof labels.field === 'string' ? labels.field : activeItem.spec.target;
  const fieldLabel = fieldLabels[fieldName] ?? humanizeFieldName(fieldName);
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
              <p className={cn('text-base font-semibold text-bark-700', adminTheme.textStrong)}>{fieldLabel}</p>
              <p className={cn('mt-1 max-w-2xl text-xs leading-relaxed text-bark-400', adminTheme.textMuted)}>
                Survey is deciding which observed value should become the trusted CampFit value. Trace IDs are kept below for audit/debug, but the review should start with the value and source.
              </p>
            </div>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border dark:border-amber-300/30">
              {statusLabel(activeItem.spec.candidateSetStatus ?? 'needs-review')}
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
          <TraceDetails className="mt-3" rows={[
            ['Survey ReviewItem', activeItem.metadata.name],
            ['Candidate set', activeItem.spec.projection?.candidateSetId ?? 'not provided'],
          ]} />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CandidateCard title="Current value" tone="current" candidate={current} fieldLabel={fieldLabel} fieldName={fieldName} />
          <CandidateCard title="Proposed value" tone="proposed" candidate={proposed} fieldLabel={fieldLabel} fieldName={fieldName} />
        </div>

        <div className="rounded-xl border border-pine-200/70 bg-pine-50/50 p-4 admin-surface">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-pine-700 admin-link">
            <Telescope className="h-3.5 w-3.5" />
            Projection summary
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            <ProjectionPill icon={<GitBranch className="h-3.5 w-3.5" />} label="Review set" value={`${session.items.length} field${session.items.length === 1 ? '' : 's'}`} />
            <ProjectionPill icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="If accepted">
              <CampFieldValue field={fieldName} value={proposed?.value} highlight />
            </ProjectionPill>
            <ProjectionPill icon={<Fingerprint className="h-3.5 w-3.5" />} label="Authority" value={sourceAuthorityLabel(proposed?.producer?.sourceAuthority)} />
          </div>
          <TraceDetails className="mt-3" rows={[
            ['Candidate set', activeItem.spec.projection?.candidateSetId ?? 'not provided'],
            ['Proposed claim', proposed?.claimTarget.claimId ?? 'choose a candidate'],
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
  title,
  tone,
  candidate,
  fieldLabel,
  fieldName,
}: {
  title: string;
  tone: 'current' | 'proposed';
  candidate: CampReviewQueueSession['items'][number]['spec']['candidates'][number] | undefined;
  fieldLabel: string;
  fieldName: string;
}) {
  if (!candidate) {
    return (
      <article className="rounded-xl border border-cream-300/70 bg-cream-50/70 p-3 text-xs text-bark-400 admin-surface">
        Missing {title.toLowerCase()} candidate.
      </article>
    );
  }

  const isProposed = tone === 'proposed';

  return (
    <article className={`rounded-xl border p-3 admin-surface-raised ${isProposed ? 'border-pine-200/80 bg-pine-50/40' : 'border-cream-300/80 bg-cream-50/70'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {isProposed ? <CheckCircle2 className="h-3.5 w-3.5 text-pine-600 admin-link" /> : <CircleDashed className="h-3.5 w-3.5 text-bark-300 admin-text-muted" />}
          <h4 className={cn('text-xs font-semibold uppercase tracking-wide text-bark-500', adminTheme.textSubtle)}>{title}</h4>
        </div>
        {candidate.confidence !== undefined && (
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-bark-500 admin-chip">
            {Math.round(candidate.confidence * 100)}%
          </span>
        )}
      </div>
      <p className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>{fieldLabel}</p>
      <div className={cn('mb-2 mt-1 rounded-lg bg-white/70 p-2 text-sm font-medium text-bark-700 admin-surface', adminTheme.textStrong)}>
        <CampFieldValue field={fieldName} value={candidate.value} highlight={isProposed} expanded />
      </div>
      <dl className="space-y-2 text-xs">
        <SourceField value={candidate.source.sourceRef} />
        <Field label="Excerpt" value={candidate.locator?.excerpt ?? 'not provided'} />
      </dl>
      <TraceDetails className="mt-3" rows={[
        ['Candidate ID', candidate.id],
        ['Claim ID', candidate.claimTarget.claimId ?? candidate.claimTarget.fieldOrBehavior],
        ['Source ID', candidate.source.sourceId ?? candidate.source.sourceRef],
        ['Locator', candidate.locator?.locator ?? candidate.locator?.scheme ?? 'not provided'],
      ]} />
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

function TraceDetails({ rows, className }: { rows: Array<readonly [string, string]>; className?: string }) {
  return (
    <details className={cn('rounded-lg border border-cream-300/70 bg-white/60 px-3 py-2 admin-surface', className)}>
      <summary className={cn('cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>
        IDs and trace links
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <IdAffordance key={label} label={label} value={value} />
        ))}
      </div>
    </details>
  );
}

function SourceField({ value }: { value: string }) {
  const isUrl = /^https?:\/\//.test(value);
  return (
    <div>
      <dt className={cn('text-[11px] uppercase tracking-wide text-bark-300', adminTheme.textMuted)}>Source</dt>
      {isUrl ? (
        <dd>
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 break-all text-bark-600 underline decoration-cream-400 underline-offset-2 hover:text-pine-700 admin-link"
          >
            <Link2 className="h-3 w-3 shrink-0" />
            {displayUrl(value)}
          </a>
        </dd>
      ) : (
        <dd className={cn('break-words text-bark-600', adminTheme.textStrong)}>{value}</dd>
      )}
    </div>
  );
}

function IdAffordance({ label, value, compact = false, className }: { label: string; value: string; compact?: boolean; className?: string }) {
  const canCopy = value && value !== 'not provided' && value !== 'choose a candidate';
  return (
    <div className={cn(compact ? 'inline-flex max-w-full items-center gap-1.5 rounded-full border border-cream-300/70 bg-white/75 px-2 py-1 admin-chip' : 'min-w-0', className)}>
      <span className={cn('text-[11px] text-bark-300', compact ? 'font-semibold' : 'block uppercase tracking-wide', adminTheme.textMuted)}>{label}</span>
      <span className={cn('min-w-0 break-all font-mono text-[11px] text-bark-500', adminTheme.text)}>{value}</span>
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

function sourceAuthorityLabel(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'not provided';
  }

  const record = value as Record<string, unknown>;
  return [record.authorityClass, record.declaredBy].filter(Boolean).map(String).join(' · ') || 'not provided';
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'empty';
  return JSON.stringify(value);
}

function humanizeFieldName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusLabel(value: string): string {
  return value.replace(/-/g, ' ');
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
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
