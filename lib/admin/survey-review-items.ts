import {
  reviewResourceApiVersion,
  type ReviewItem,
  type ReviewCandidate,
} from '@kontourai/survey';

import {
  campfitVocabulary,
} from '../trust-vocabulary';
import type { CampChangeProposal, FieldDiff } from './types';

export interface CampReviewQueueSession {
  readonly items: readonly ReviewItem[];
  readonly activeItemName: string;
  readonly notesByItemName: Readonly<Record<string, string>>;
  readonly decisionsByItemName: Readonly<Record<string, 'accept-proposed' | 'keep-current' | 'reject-proposed'>>;
  readonly reviewedAt: string;
  readonly actorId: string;
}

export interface CampReviewItemOptions {
  readonly reviewedAt?: string;
  readonly actorId?: string;
  readonly includeAppliedFields?: boolean;
}

export function buildCampSurveyReviewQueueSession(
  proposal: CampChangeProposal,
  options: CampReviewItemOptions = {},
): CampReviewQueueSession {
  const items = buildCampSurveyReviewItems(proposal, options);

  return {
    items,
    activeItemName: items[0]?.metadata.name ?? '',
    notesByItemName: {},
    decisionsByItemName: {},
    reviewedAt: options.reviewedAt ?? proposal.reviewedAt ?? new Date().toISOString(),
    actorId: options.actorId ?? proposal.reviewedBy ?? 'campfit-admin',
  };
}

export function buildCampSurveyReviewItems(
  proposal: CampChangeProposal,
  options: CampReviewItemOptions = {},
): ReviewItem[] {
  const appliedFields = new Set(proposal.appliedFields ?? []);

  return Object.entries(proposal.proposedChanges)
    .filter(([field]) => options.includeAppliedFields || !appliedFields.has(field))
    .map(([field, diff]) => buildCampSurveyReviewItem(proposal, field, diff));
}

// SKIP decision (survey 1.x adoption): NOT built on Survey's
// currentProposedReviewItem. That builder derives each candidate's top-level
// `id` as `${metadata.name}.${suffix}`, coupling the candidate-id prefix to the
// ReviewItem name. CampFit deliberately uses two distinct namespaces: a
// human-readable item name (camp-proposal-<id>-<field>) and a structured
// candidate-set id (camp.<campId>.field.<field>.proposal.<proposalId>.candidates)
// that candidate ids are built from. No candidateIdSuffix + projection.candidateSetId
// combination reproduces campfit's exact candidate ids without changing either
// metadata.name (breaking name-keyed session maps + sessionStorage event replay)
// or the candidate ids (breaking persisted candidate/stableId lookups). Adopting
// would silently rename persisted candidate ids. Empirically verified byte-for-byte;
// see docs/survey-1.x-migration.md and the friction journal.
function buildCampSurveyReviewItem(
  proposal: CampChangeProposal,
  field: string,
  diff: FieldDiff,
): ReviewItem {
  const candidateSetId = campCandidateSetId(proposal.campId, field, proposal.id);
  const proposedSourceUrl = displayString(diff.sourceUrl ?? proposal.sourceUrl);
  const createdAt = proposal.createdAt;
  const feedbackTags = (proposal.feedbackTags ?? []).map(displayString);

  return {
    apiVersion: reviewResourceApiVersion,
    kind: 'ReviewItem',
    metadata: {
      name: campReviewItemName(proposal.id, field),
      labels: {
        domain: 'public-directory',
        product: 'campfit',
        proposalId: proposal.id,
        campId: proposal.campId,
        field,
      },
      producer: {
        displayName: proposal.campName ?? 'CampFit',
        slug: proposal.campSlug,
        communitySlug: proposal.communitySlug,
        source: 'campfit.admin.review',
      },
    },
    spec: {
      target: field,
      selectedCandidateId: undefined,
      candidateSetStatus: 'needs-review',
      rationale: 'CampFit crawl proposal requires operator review before projecting a verified claim.',
      projection: {
        candidateSetId,
      },
      producerPolicy: {
        decisionMode: 'current-proposed',
        sourceAuthorityProjection: 'only-for-selected-source-backed-value',
        feedbackTags,
      },
      candidates: [
        currentCandidate(proposal, field, diff, candidateSetId, createdAt),
        proposedCandidate(proposal, field, diff, candidateSetId, proposedSourceUrl, createdAt),
      ],
    },
    status: {
      observedCandidateCount: 2,
    },
  };
}

function currentCandidate(
  proposal: CampChangeProposal,
  field: string,
  diff: FieldDiff,
  candidateSetId: string,
  observedAt: string,
): ReviewCandidate {
  return {
    id: `${candidateSetId}.current.candidate`,
    role: 'current',
    value: diff.old,
    sourceRank: 2,
    source: {
      sourceId: `camp.${proposal.campId}.field.${field}.proposal.${proposal.id}.current.source`,
      sourceRef: `campfit:camp:${proposal.campId}:field:${field}:current`,
      kind: 'manual-entry',
      observedAt,
      locatorScheme: 'structured-field',
    },
    locator: {
      scheme: 'structured-field',
      locator: `field:${field}`,
      excerpt: 'Current CampFit value before applying the crawl proposal.',
    },
    extraction: {
      extractionId: campObservationId(proposal.campId, field, proposal.id, 'current'),
      target: field,
      extractor: 'campfit-current-record',
      extractedAt: observedAt,
    },
    claimTarget: {
      claimId: campCandidateClaimId(proposal.campId, field, proposal.id, 'current'),
      subjectType: campfitVocabulary.subjectType,
      subjectId: proposal.campId,
      surface: campfitVocabulary.surface,
      claimType: campfitVocabulary.claimTypes.scalarFieldCandidate,
      fieldOrBehavior: field,
      impactLevel: 'medium',
      evidenceType: 'human_attestation',
      evidenceMethod: 'observation',
      collectedBy: 'campfit-current-record',
    },
    projection: {
      rawSourceId: `camp.${proposal.campId}.field.${field}.proposal.${proposal.id}.current.source`,
      extractionId: campObservationId(proposal.campId, field, proposal.id, 'current'),
      candidateSetId,
      candidateId: `${candidateSetId}.current.candidate`,
      claimId: campCandidateClaimId(proposal.campId, field, proposal.id, 'current'),
    },
    producer: {
      status: 'current-managed-value',
      rawValue: diff.old,
      decisionEffect: campfitVocabulary.decisionEffects.keptCurrentValue,
    },
  };
}

function proposedCandidate(
  proposal: CampChangeProposal,
  field: string,
  diff: FieldDiff,
  candidateSetId: string,
  sourceUrl: string,
  observedAt: string,
): ReviewCandidate {
  return {
    id: `${candidateSetId}.proposed.candidate`,
    role: 'proposed',
    value: diff.new,
    confidence: diff.confidence,
    sourceRank: 1,
    source: {
      sourceId: `camp.${proposal.campId}.field.${field}.proposal.${proposal.id}.source`,
      sourceRef: sourceUrl,
      kind: 'web-page',
      observedAt,
      fetchedAt: proposal.crawlCompletedAt ?? undefined,
      locatorScheme: 'html',
    },
    locator: {
      scheme: 'html',
      locator: `field:${field}`,
      excerpt: diff.excerpt === undefined ? undefined : displayString(diff.excerpt),
    },
    extraction: {
      extractionId: campObservationId(proposal.campId, field, proposal.id, 'proposed'),
      target: field,
      confidence: diff.confidence,
      extractor: proposal.extractionModel || 'campfit-crawler',
      extractedAt: observedAt,
    },
    claimTarget: {
      claimId: campCandidateClaimId(proposal.campId, field, proposal.id, 'proposed'),
      subjectType: campfitVocabulary.subjectType,
      subjectId: proposal.campId,
      surface: campfitVocabulary.surface,
      claimType: campfitVocabulary.claimTypes.scalarFieldCandidate,
      fieldOrBehavior: field,
      impactLevel: 'medium',
      evidenceType: 'crawl_observation',
      evidenceMethod: 'extraction',
      collectedBy: proposal.extractionModel || 'campfit-crawler',
    },
    projection: {
      rawSourceId: `camp.${proposal.campId}.field.${field}.proposal.${proposal.id}.source`,
      extractionId: campObservationId(proposal.campId, field, proposal.id, 'proposed'),
      candidateSetId,
      candidateId: `${candidateSetId}.proposed.candidate`,
      claimId: campCandidateClaimId(proposal.campId, field, proposal.id, 'proposed'),
    },
    producer: {
      mode: diff.mode,
      oldValue: diff.old,
      rawValue: diff.new,
      proposalId: proposal.id,
      sourceAuthority: {
        authorityClass: 'publisher_owned_page',
        declaredBy: proposal.extractionModel || 'campfit-crawler',
        scope: `Camp ${proposal.campId} field ${field}`,
      },
      decisionEffect: campfitVocabulary.decisionEffects.acceptedCandidateValue,
    },
  };
}

function displayString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function campReviewItemName(proposalId: string, field: string): string {
  return `camp-proposal-${proposalId}-${field}`;
}

function campObservationId(campId: string, field: string, eventId: string, role?: string): string {
  return ['camp', campId, 'field', field, eventId, role].filter(Boolean).join('.');
}

function campCandidateSetId(campId: string, field: string, proposalId: string): string {
  return `camp.${campId}.field.${field}.proposal.${proposalId}.candidates`;
}

function campCandidateClaimId(campId: string, field: string, proposalId: string, role: 'current' | 'proposed'): string {
  return `camp.${campId}.field.${field}.proposal.${proposalId}.${role}.claim`;
}
