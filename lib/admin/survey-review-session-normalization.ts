import type { CampReviewQueueSession } from './survey-review-items';

export function normalizeReviewQueueSession(session: CampReviewQueueSession): CampReviewQueueSession {
  return {
    ...session,
    activeItemName: displayString(session.activeItemName),
    actorId: displayString(session.actorId),
    reviewedAt: displayString(session.reviewedAt),
    notesByItemName: stringRecord(session.notesByItemName),
    decisionsByItemName: session.decisionsByItemName,
    items: session.items.map((item) => ({
      ...item,
      metadata: {
        ...item.metadata,
        name: displayString(item.metadata.name),
        labels: item.metadata.labels ? stringRecord(item.metadata.labels) : undefined,
        annotations: item.metadata.annotations ? stringRecord(item.metadata.annotations) : undefined,
      },
      spec: {
        ...item.spec,
        target: displayString(item.spec.target),
        selectedCandidateId: item.spec.selectedCandidateId === undefined ? undefined : displayString(item.spec.selectedCandidateId),
        candidateSetStatus: item.spec.candidateSetStatus,
        rationale: item.spec.rationale === undefined ? undefined : displayString(item.spec.rationale),
        producerPolicy: normalizeProducerPolicy(item.spec.producerPolicy),
        candidates: item.spec.candidates.map((candidate) => ({
          ...candidate,
          id: displayString(candidate.id),
          role: candidate.role,
          value: displayString(candidate.value),
          source: {
            ...candidate.source,
            sourceId: candidate.source.sourceId === undefined ? undefined : displayString(candidate.source.sourceId),
            sourceRef: displayString(candidate.source.sourceRef),
            kind: candidate.source.kind,
            observedAt: candidate.source.observedAt === undefined ? undefined : displayString(candidate.source.observedAt),
            fetchedAt: candidate.source.fetchedAt === undefined ? undefined : displayString(candidate.source.fetchedAt),
            locatorScheme: candidate.source.locatorScheme,
          },
          locator: candidate.locator
            ? {
                ...candidate.locator,
                scheme: candidate.locator.scheme,
                locator: candidate.locator.locator === undefined ? undefined : displayString(candidate.locator.locator),
                excerpt: candidate.locator.excerpt === undefined ? undefined : displayString(candidate.locator.excerpt),
              }
            : undefined,
          extraction: {
            ...candidate.extraction,
            extractionId: displayString(candidate.extraction.extractionId),
            target: displayString(candidate.extraction.target),
            extractor: candidate.extraction.extractor === undefined ? undefined : displayString(candidate.extraction.extractor),
            extractedAt: candidate.extraction.extractedAt === undefined ? undefined : displayString(candidate.extraction.extractedAt),
          },
          claimTarget: {
            ...candidate.claimTarget,
            claimId: candidate.claimTarget.claimId === undefined ? undefined : displayString(candidate.claimTarget.claimId),
            subjectType: displayString(candidate.claimTarget.subjectType),
            subjectId: displayString(candidate.claimTarget.subjectId),
            surface: displayString(candidate.claimTarget.surface),
            claimType: displayString(candidate.claimTarget.claimType),
            fieldOrBehavior: displayString(candidate.claimTarget.fieldOrBehavior),
          },
        })),
      },
    })),
  };
}

function normalizeProducerPolicy(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policy = value as Record<string, unknown>;
  const feedbackTags = Array.isArray(policy.feedbackTags)
    ? policy.feedbackTags.map(displayString)
    : undefined;
  return {
    ...policy,
    feedbackTags,
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
