import { validateTrustBundle, type TrustBundle, type TrustStatus } from '@kontourai/surface';
import {
  buildAuthorizedActionAuthorizing,
  buildPromptRef,
  buildSurveyTrustBundle,
  fieldObservation,
  manualEntrySource,
  reviewedCurrentProposedResolution,
  SurveyInputBuilder,
  webPageSource,
  type SurveyObservationInput,
  type SurveyInput,
} from '@kontourai/survey';

import type { FieldDiff, ProposedChanges } from './types';
import { resolveReviewExcerpt } from './review-excerpt-resolution';
import {
  campfitVocabulary,
  type CampfitScalarClaimType,
} from '../trust-vocabulary';

type ReviewStatus = 'verified' | 'assumed' | 'rejected';

export interface CampReviewTrustInputArgs {
  proposalId: string;
  campId: string;
  sourceUrl: string;
  proposedChanges: ProposedChanges;
  approvedFields: string[];
  reviewer: string;
  reviewedAt: string;
  proposalCreatedAt?: string;
  extractionModel?: string;
  reviewerNotes?: string | null;
  feedbackTags?: string[];
  snapshotRef?: string;
  snapshotBody?: string;
}

export interface CampAttestationTrustInputArgs {
  campId: string;
  fields: string[];
  actor: string;
  attestedAt: string;
  notes?: string | null;
  values?: Record<string, unknown>;
  mode?: 'source' | 'override';
  sourceRef?: string;
  sourceLocator?: string;
  excerpt?: string;
}

export function buildCampReviewTrustInput(args: CampReviewTrustInputArgs): TrustBundle {
  return validateTrustBundle(buildSurveyTrustBundle(buildCampReviewSurveyInput(args)));
}

export function buildCampReviewSurveyInput(args: CampReviewTrustInputArgs): SurveyInput {
  const approved = new Set(args.approvedFields);
  const extractedAt = args.proposalCreatedAt ?? args.reviewedAt;
  const builder = new SurveyInputBuilder({
    source: 'campfit.admin.review',
    generatedAt: args.reviewedAt,
  });

  for (const [field, diff] of Object.entries(args.proposedChanges)) {
    const status: ReviewStatus = approved.has(field) ? 'verified' : 'rejected';
    builder.addClaimRecords(campReviewResolution({
      proposalId: args.proposalId,
      campId: args.campId,
      field,
      diff,
      status,
      sourceUrl: diff.sourceUrl ?? args.sourceUrl,
      reviewer: args.reviewer,
      reviewedAt: args.reviewedAt,
      extractedAt,
      extractionModel: args.extractionModel,
      reviewerNotes: args.reviewerNotes,
      feedbackTags: args.feedbackTags,
      snapshotRef: args.snapshotRef,
      snapshotBody: args.snapshotBody,
    }));
  }

  return builder.build();
}

export function buildCampAttestationTrustInput(args: CampAttestationTrustInputArgs): TrustBundle {
  const builder = new SurveyInputBuilder({
    source: 'campfit.admin.attestation',
    generatedAt: args.attestedAt,
  });

  for (const field of args.fields) {
    const value = args.values?.[field] ?? null;
    builder.addObservation(fieldObservation({
      id: campObservationId(args.campId, field, 'attestation'),
      field,
      value,
      rawSource: manualEntrySource({
        id: `camp.${args.campId}.field.${field}.attestation.source`,
        sourceRef: args.mode === 'source' && args.sourceRef ? args.sourceRef : `admin:${args.actor}`,
        observedAt: args.attestedAt,
        metadata: {
          trustProducer: 'campfit.admin.attestation',
          mode: args.mode ?? 'override',
          reason: args.mode === 'override' ? args.notes ?? undefined : undefined,
          notes: args.notes ?? undefined,
        },
      }),
      extraction: {
        extractor: 'campfit-admin',
        extractedAt: args.attestedAt,
        locator: args.mode === 'source' && args.sourceLocator ? args.sourceLocator : `field:${field}`,
        excerpt: args.mode === 'source' ? args.excerpt : undefined,
        metadata: {
          reviewKind: 'manual-attestation',
          mode: args.mode ?? 'override',
        },
      },
      reviewOutcome: {
        status: args.mode === 'source' ? 'verified' : 'assumed',
        actor: args.actor,
        reviewedAt: args.attestedAt,
        rationale: args.notes ?? 'Operator reviewed this field and attested the current value.',
      },
      claim: campClaim({
        campId: args.campId,
        field,
        status: args.mode === 'source' ? 'verified' : 'assumed',
        collectedBy: 'campfit-admin',
        value,
        metadata: {
          reviewKind: 'manual-attestation',
          mode: args.mode ?? 'override',
        },
      }),
    }));
  }

  const bundle = buildSurveyTrustBundle(builder.build());
  // A human may perform the extraction, but the canonical Evidence method
  // remains attestation; producer identity is carried separately in metadata.
  for (const evidence of bundle.evidence) {
    evidence.method = 'attestation';
    evidence.metadata = {
      ...evidence.metadata,
      mode: args.mode ?? 'override',
      trustProducer: 'campfit.admin.attestation',
      ...(args.mode === 'override' && args.notes ? { reason: args.notes } : {}),
    };
  }
  return validateTrustBundle(bundle);
}

function campReviewResolution(args: {
  proposalId: string;
  campId: string;
  field: string;
  diff: FieldDiff;
  status: ReviewStatus;
  sourceUrl: string;
  reviewer: string;
  reviewedAt: string;
  extractedAt: string;
  extractionModel?: string;
  reviewerNotes?: string | null;
  feedbackTags?: string[];
  snapshotRef?: string;
  snapshotBody?: string;
}) {
  const approved = args.status === 'verified';
  const decisionEffect = approved
    ? campfitVocabulary.decisionEffects.acceptedCandidateValue
    : campfitVocabulary.decisionEffects.keptCurrentValue;

  const comfortZoneNote = explicitComfortZoneNote(args.feedbackTags, args.reviewerNotes);

  return reviewedCurrentProposedResolution({
    id: campCandidateSetId(args.campId, args.field, args.proposalId),
    target: campFieldTarget(args.campId, args.field),
    selectedCandidateRole: approved ? 'proposed' : 'current',
    selectedClaimId: campCanonicalClaimId(args.campId, args.field),
    status: 'resolved',
    rationale: args.reviewerNotes ?? (approved
      ? 'Reviewer accepted the proposed value.'
      : 'Reviewer rejected the proposed value and kept the current value.'),
    metadata: {
      proposalId: args.proposalId,
      reviewKind: 'crawl-proposal',
      decisionEffect,
    },
    reviewOutcome: (() => {
      const authorizing = buildAuthorizedActionAuthorizing({
        promptRef: buildPromptRef({ scheme: 'survey', module: 'campfit', component: 'approve-field' }),
        renderedPrompt: `${approved ? 'Approve' : 'Reject'} the proposed value for field \`${args.field}\` on camp ${args.campId}?`,
        action: args.reviewerNotes?.trim() ? 'typed' : 'affirmed-control',
        authorityRef: `campfit-reviewer:${args.reviewer}`,
      });
      return {
        id: `${campCandidateSetId(args.campId, args.field, args.proposalId)}.review`,
        status: 'verified',
        actor: args.reviewer,
        reviewedAt: args.reviewedAt,
        rationale: args.reviewerNotes ?? undefined,
        withinComfortZone: !approved && comfortZoneNote ? false : undefined,
        comfortZoneNote,
        authorizing,
        metadata: {
          proposalId: args.proposalId,
          proposalDecision: approved ? 'approved' : 'rejected',
          decisionEffect,
          feedbackTags: args.feedbackTags,
        },
      };
    })(),
    selectedClaimStatus: 'verified',
    unselectedClaimStatus: approved ? 'superseded' : 'rejected',
    currentObservation: currentCampReviewObservation({
      ...args,
      selected: !approved,
      decisionEffect,
    }),
    proposedObservation: proposedCampReviewObservation({
      ...args,
      selected: approved,
      decisionEffect,
    }),
  });
}

function explicitComfortZoneNote(feedbackTags?: string[], reviewerNotes?: string | null): string | undefined {
  const hasExplicitAuthorityTag = feedbackTags?.some((tag) => {
    const normalized = tag.trim().toLowerCase();
    return normalized === 'needs-authority-review' || normalized === 'needs-domain-review';
  }) ?? false;

  if (!hasExplicitAuthorityTag) return undefined;

  const notes = reviewerNotes?.trim();
  return notes && notes.length > 0
    ? notes
    : 'Reviewer marked this decision for authority or domain review.';
}

function currentCampReviewObservation(args: {
  proposalId: string;
  campId: string;
  field: string;
  diff: FieldDiff;
  status: TrustStatus;
  sourceUrl: string;
  reviewer: string;
  reviewedAt: string;
  extractedAt: string;
  extractionModel?: string;
  reviewerNotes?: string | null;
  selected: boolean;
  decisionEffect: string;
}): SurveyObservationInput {
  return fieldObservation({
    id: campObservationId(args.campId, args.field, args.proposalId, 'current'),
    field: args.field,
    value: args.diff.old,
    rawSource: manualEntrySource({
      id: `camp.${args.campId}.field.${args.field}.proposal.${args.proposalId}.current.source`,
      sourceRef: `campfit:camp:${args.campId}:field:${args.field}:current`,
      observedAt: args.reviewedAt,
      metadata: {
        proposalId: args.proposalId,
        trustProducer: 'campfit.current-value-review',
      },
    }),
    extraction: {
      locator: `field:${args.field}`,
      extractor: 'campfit-current-record',
      extractedAt: args.reviewedAt,
      metadata: {
        mode: 'current-value',
        proposedValue: args.diff.new,
      },
    },
    candidate: {
      sourceRank: args.selected ? 1 : 2,
      metadata: {
        role: 'current-value',
        decisionEffect: args.decisionEffect,
      },
    },
    claim: campClaim({
      campId: args.campId,
      field: args.field,
      status: args.selected ? 'verified' : 'superseded',
      claimType: args.selected ? campfitVocabulary.claimTypes.scalarField : campfitVocabulary.claimTypes.scalarFieldCandidate,
      collectedBy: 'campfit-current-record',
      value: args.diff.old,
      claimId: args.selected
        ? campCanonicalClaimId(args.campId, args.field)
        : campCandidateClaimId(args.campId, args.field, args.proposalId, 'current'),
      metadata: {
        proposalId: args.proposalId,
        reviewKind: 'crawl-proposal',
        candidateRole: 'current-value',
        decisionEffect: args.decisionEffect,
      },
    }),
  });
}

function proposedCampReviewObservation(args: {
  proposalId: string;
  campId: string;
  field: string;
  diff: FieldDiff;
  status: ReviewStatus;
  sourceUrl: string;
  reviewer: string;
  reviewedAt: string;
  extractedAt: string;
  extractionModel?: string;
  reviewerNotes?: string | null;
  selected: boolean;
  decisionEffect: string;
  snapshotRef?: string;
  snapshotBody?: string;
}): SurveyObservationInput {
  const rejectionReason = args.selected
    ? undefined
    : rejectedProposedCandidateReason(args.reviewerNotes);

  const excerptResolution = args.diff.excerpt && args.snapshotBody
    ? resolveReviewExcerpt(args.diff.excerpt, args.snapshotBody)
    : undefined;
  // A present immutable snapshot opts this observation into source-citation
  // enrichment and must resolve exactly. Snapshotless legacy proposals still
  // record their general review provenance, but do not carry the excerpt as
  // evidence (and therefore cannot be displayed as citation-verified).
  if (args.selected && args.diff.excerpt && args.snapshotRef && excerptResolution?.state !== 'verified') {
    throw new Error(`Approved crawl field "${args.field}" lacks an exact stored-snapshot citation.`);
  }
  return fieldObservation({
    id: campObservationId(args.campId, args.field, args.proposalId, 'proposed'),
    field: args.field,
    value: args.diff.new,
    rawSource: webPageSource({
      id: `camp.${args.campId}.field.${args.field}.proposal.${args.proposalId}.source`,
      sourceRef: args.snapshotRef ?? args.sourceUrl,
      observedAt: args.extractedAt,
      metadata: {
        proposalId: args.proposalId,
        trustProducer: 'campfit.crawl-review',
      },
    }),
    extraction: {
      confidence: args.diff.confidence,
      locator: excerptResolution?.state === 'verified' ? excerptResolution.locator : `field:${args.field}`,
      excerpt: excerptResolution?.state === 'verified' ? args.diff.excerpt : undefined,
      extractor: args.extractionModel ?? 'campfit-crawler',
      extractedAt: args.extractedAt,
      metadata: {
        mode: args.diff.mode,
        oldValue: args.diff.old,
      },
    },
    candidate: {
      confidence: args.diff.confidence,
      sourceRank: args.selected ? 1 : 2,
      rejectionReason,
      metadata: {
        role: 'proposed-value',
        decisionEffect: args.decisionEffect,
      },
    },
    claim: campClaim({
      campId: args.campId,
      field: args.field,
      status: args.status,
      claimType: args.selected ? campfitVocabulary.claimTypes.scalarField : campfitVocabulary.claimTypes.scalarFieldCandidate,
      collectedBy: args.extractionModel ?? 'campfit-crawler',
      value: args.diff.new,
      claimId: args.selected
        ? campCanonicalClaimId(args.campId, args.field)
        : campCandidateClaimId(args.campId, args.field, args.proposalId, 'proposed'),
      metadata: {
        proposalId: args.proposalId,
        reviewKind: 'crawl-proposal',
        candidateRole: 'proposed-value',
        decisionEffect: args.decisionEffect,
      },
    }),
  });
}

function rejectedProposedCandidateReason(reviewerNotes?: string | null): string {
  const notes = reviewerNotes?.trim();
  return notes && notes.length > 0
    ? notes
    : 'Reviewer rejected the proposed value and kept the current value.';
}

function campClaim(args: {
  campId: string;
  field: string;
  status: TrustStatus;
  claimType?: CampfitScalarClaimType;
  collectedBy: string;
  value: unknown;
  claimId?: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: args.claimId ?? campCanonicalClaimId(args.campId, args.field),
    subjectType: campfitVocabulary.subjectType,
    subjectId: args.campId,
    facet: campfitVocabulary.facet,
    claimType: args.claimType ?? campfitVocabulary.claimTypes.scalarField,
    fieldOrBehavior: args.field,
    value: args.value,
    status: args.status,
    impactLevel: 'medium' as const,
    collectedBy: args.collectedBy,
    metadata: args.metadata,
  };
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

/**
 * The canonical Claim id for a Camp Attribute's Current Claim (docs/contexts/
 * trust-review-provenance/CONTEXT.md: "Current Claim" / "Attribute").
 * Exported so other modules that mint Claims/ClaimGroup requirements against
 * the SAME Camp field (e.g. `lib/admin/verification-policy.ts`'s Verified
 * Camp Claim Set) reuse this exact convention instead of inventing a second
 * claim-identity scheme for the same Attribute.
 */
export function campCanonicalClaimId(campId: string, field: string): string {
  return `camp.${campId}.field.${field}`;
}

function campFieldTarget(campId: string, field: string): string {
  return `camp.${campId}.field.${field}`;
}
