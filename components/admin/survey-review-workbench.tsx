'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewSessionEvent } from '@kontourai/survey';

import {
  createPersistentReviewSessionEventStore,
  mountReviewWorkbench,
} from '@kontourai/survey/review-workbench';
import type { CampReviewQueueSession } from '@/lib/admin/survey-review-items';
import { createCampSurveyPresentationAdapter } from '@/lib/admin/survey-presentation';

/**
 * Mounts the embeddable Survey review workbench (field-diff cards, per-field
 * decisions, provenance excerpts, and per-card audit details) and themes it to
 * campfit's brand via the `theme-campfit` token set (styles/survey-review-workbench.css).
 *
 * This is the SINGLE review surface: the field-diff it renders replaces the old
 * bespoke "Proposed Changes" list, and its per-card audit details replace the
 * separate decision trail. Everything the reviewer needs — current vs proposed,
 * the source excerpt/link the value came from, and the decision controls — is here.
 */
export function SurveyReviewWorkbench({
  session,
  isNewCamp = false,
  eventPersistence,
  onPersistedEventsChange,
  fieldLabels = {},
}: {
  session: CampReviewQueueSession;
  isNewCamp?: boolean;
  eventPersistence?: {
    readonly proposalId: string;
    readonly reviewSessionId: string;
    readonly initialEvents: readonly ReviewSessionEvent[];
  };
  onPersistedEventsChange?: (events: readonly ReviewSessionEvent[]) => void;
  fieldLabels?: Record<string, string>;
}) {
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const storageKey = `campfit:${session.items.map((item) => item.metadata.name).join(',')}`;
  const presentationAdapter = useMemo(
    () => createCampSurveyPresentationAdapter(fieldLabels, { newCamp: isNewCamp }),
    [fieldLabels, isNewCamp],
  );

  useEffect(() => {
    if (!workbenchRef.current) return;
    mountReviewWorkbench(workbenchRef.current, session, {
      presentationAdapter,
      eventStore: eventPersistence
        ? createPersistentReviewSessionEventStore({
            initialEvents: eventPersistence.initialEvents,
            persist: async ({ events, expectedEventCount }) => {
              const persisted = await persistProposalReviewEvents(
                eventPersistence.proposalId,
                eventPersistence.reviewSessionId,
                events,
                expectedEventCount,
              );
              onPersistedEventsChange?.(persisted.events);
              return persisted;
            },
            onStatusChange: (state) => {
              setPersistenceError(state.status === 'error' ? 'Survey changes were not saved. Reload the review page before continuing.' : null);
            },
          })
        : createSessionStorageEventStore(storageKey),
    });
  }, [eventPersistence, onPersistedEventsChange, presentationAdapter, session, storageKey]);

  if (session.items.length === 0) {
    return (
      <div className="rounded-xl border border-cream-300/70 bg-cream-50/80 p-3 text-xs text-bark-400 admin-surface">
        No Survey ReviewItems were generated for this proposal.
      </div>
    );
  }

  return (
    <section className="space-y-3" aria-label="Survey review workbench">
      <div className="overflow-hidden rounded-xl border border-pine-200/70 bg-white/80 admin-surface-raised">
        <div ref={workbenchRef} className="survey-workbench-embed theme-campfit" />
      </div>

      {persistenceError && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-800" role="alert">
          {persistenceError}
        </div>
      )}
    </section>
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
  reviewSessionId: string,
  events: readonly ReviewSessionEvent[],
  expectedEventCount: number,
): Promise<{ events: readonly ReviewSessionEvent[]; eventCount: number }> {
  const response = await fetch(`/api/admin/review/${proposalId}/survey-events`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewSessionId, events, expectedEventCount }),
  });
  if (!response.ok) {
    throw new Error(`Failed to persist Survey review events: ${response.status}`);
  }
  return {
    events,
    eventCount: events.length,
  };
}
