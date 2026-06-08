import type { ReviewSessionEvent } from '@kontourai/survey';

export function normalizeReviewSessionEvents(events: readonly ReviewSessionEvent[]): ReviewSessionEvent[] {
  return events.map((event) => normalizeReviewSessionEvent(event));
}

export function normalizeReviewSessionEvent(event: ReviewSessionEvent): ReviewSessionEvent {
  return {
    ...event,
    metadata: {
      ...event.metadata,
      name: displayString(event.metadata.name),
      labels: event.metadata.labels ? stringRecord(event.metadata.labels) : undefined,
      annotations: event.metadata.annotations ? stringRecord(event.metadata.annotations) : undefined,
    },
    spec: {
      ...event.spec,
      sessionName: displayString(event.spec.sessionName),
      eventType: event.spec.eventType,
      occurredAt: displayString(event.spec.occurredAt),
      actor: event.spec.actor
        ? {
            id: displayString(event.spec.actor.id),
            displayName: event.spec.actor.displayName === undefined
              ? undefined
              : displayString(event.spec.actor.displayName),
          }
        : undefined,
      reviewItemName: event.spec.reviewItemName === undefined ? undefined : displayString(event.spec.reviewItemName),
      activeItemName: event.spec.activeItemName === undefined ? undefined : displayString(event.spec.activeItemName),
      reviewDecisionName: event.spec.reviewDecisionName === undefined ? undefined : displayString(event.spec.reviewDecisionName),
      candidateId: event.spec.candidateId === undefined ? undefined : displayString(event.spec.candidateId),
      status: event.spec.status,
      rationale: event.spec.rationale === undefined ? undefined : displayString(event.spec.rationale),
      data: event.spec.data && typeof event.spec.data === 'object' && !Array.isArray(event.spec.data)
        ? event.spec.data
        : undefined,
    },
  };
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([key, recordValue]) => [key, displayString(recordValue)]),
  );
}

function displayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
