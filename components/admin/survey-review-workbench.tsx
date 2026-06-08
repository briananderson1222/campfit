'use client';

import React, { useEffect, useRef } from 'react';
import { CheckCircle2, CircleDashed, FileJson2, ShieldCheck, Telescope } from 'lucide-react';
import { mountReviewWorkbench } from '@kontourai/survey/review-workbench';

import type { CampReviewQueueSession } from '@/lib/admin/survey-review-items';

export function SurveyReviewWorkbench({ session }: { session: CampReviewQueueSession }) {
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const storageKey = `campfit:${session.items.map((item) => item.metadata.name).join(',')}`;

  useEffect(() => {
    if (!workbenchRef.current) return;
    mountReviewWorkbench(workbenchRef.current, session, {
      eventStore: createSessionStorageEventStore(storageKey),
    });
  }, [session, storageKey]);

  const activeItem = session.items.find((item) => item.metadata.name === session.activeItemName) ?? session.items[0];
  if (!activeItem) {
    return (
      <div className="rounded-xl border border-cream-300/70 bg-cream-50/80 p-3 text-xs text-bark-400">
        No Survey ReviewItems were generated for this proposal.
      </div>
    );
  }

  const current = activeItem.spec.candidates.find((candidate) => candidate.role === 'current');
  const proposed = activeItem.spec.candidates.find((candidate) => candidate.role === 'proposed');

  return (
    <section className="space-y-3" aria-label="Survey review workbench">
      <div className="overflow-hidden rounded-xl border border-pine-200/70 bg-white/80">
        <div ref={workbenchRef} className="survey-workbench-embed theme-survey" />
      </div>

      <div className="grid grid-cols-1 gap-2">
        <div className="rounded-xl border border-cream-300/70 bg-cream-50/80 p-3">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-bark-300">Active ReviewItem</p>
              <p className="font-mono text-xs text-bark-600 break-all">{activeItem.metadata.name}</p>
            </div>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
              {activeItem.spec.candidateSetStatus ?? 'needs-review'}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Field label="Target" value={activeItem.spec.target} />
            <Field label="Actor" value={session.actorId} />
            <Field label="Items" value={String(session.items.length)} />
            <Field label="Reviewed at" value={new Date(session.reviewedAt).toLocaleString()} />
          </dl>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <CandidateCard title="Current" tone="current" candidate={current} />
          <CandidateCard title="Proposed" tone="proposed" candidate={proposed} />
        </div>

        <div className="rounded-xl border border-pine-200/70 bg-pine-50/50 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-pine-700">
            <Telescope className="h-3.5 w-3.5" />
            Surface preview
          </div>
          <dl className="grid grid-cols-1 gap-2 text-xs">
            <Field label="Candidate set" value={activeItem.spec.projection?.candidateSetId ?? 'not provided'} />
            <Field label="Selected claim after review" value={proposed?.claimTarget.claimId ?? 'choose a candidate'} />
            <Field label="Source authority" value={sourceAuthorityLabel(proposed?.producer?.sourceAuthority)} />
          </dl>
        </div>
      </div>

      <details className="rounded-xl border border-cream-300/70 bg-cream-50/70 p-3">
        <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-bark-400">
          <FileJson2 className="h-3.5 w-3.5" />
          Survey queue payload
        </summary>
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-bark-500">
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
}: {
  title: string;
  tone: 'current' | 'proposed';
  candidate: CampReviewQueueSession['items'][number]['spec']['candidates'][number] | undefined;
}) {
  if (!candidate) {
    return (
      <article className="rounded-xl border border-cream-300/70 bg-cream-50/70 p-3 text-xs text-bark-400">
        Missing {title.toLowerCase()} candidate.
      </article>
    );
  }

  const isProposed = tone === 'proposed';

  return (
    <article className={`rounded-xl border p-3 ${isProposed ? 'border-pine-200/80 bg-pine-50/40' : 'border-cream-300/80 bg-cream-50/70'}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {isProposed ? <CheckCircle2 className="h-3.5 w-3.5 text-pine-600" /> : <CircleDashed className="h-3.5 w-3.5 text-bark-300" />}
          <h4 className="text-xs font-semibold uppercase tracking-wide text-bark-500">{title}</h4>
        </div>
        {candidate.confidence !== undefined && (
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-bark-500">
            {Math.round(candidate.confidence * 100)}%
          </span>
        )}
      </div>
      <div className="mb-2 rounded-lg bg-white/70 p-2 text-sm font-medium text-bark-700">
        {formatValue(candidate.value)}
      </div>
      <dl className="space-y-2 text-xs">
        <Field label="Source" value={candidate.source.sourceRef} />
        <Field label="Locator" value={candidate.locator?.locator ?? candidate.locator?.scheme ?? 'not provided'} />
        <Field label="Excerpt" value={candidate.locator?.excerpt ?? 'not provided'} />
        <Field label="Claim" value={candidate.claimTarget.claimId ?? candidate.claimTarget.fieldOrBehavior} />
      </dl>
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-bark-300">{label}</dt>
      <dd className="break-words text-bark-600">{value}</dd>
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
