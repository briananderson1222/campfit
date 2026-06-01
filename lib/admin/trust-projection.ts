import { validateTrustInput, type TrustInput } from '@kontourai/surface';
import {
  buildSurveyTrustInput,
  fieldObservation,
  manualEntrySource,
  SurveyInputBuilder,
  webPageSource,
} from '@kontourai/survey';

import type { FieldDiff, ProposedChanges } from './types';
import {
  CAMPFIT_CLAIM_TYPES,
  CAMPFIT_DECISION_EFFECTS,
  CAMPFIT_TRUST_SUBJECT_TYPE,
  CAMPFIT_TRUST_SURFACE,
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
}

export interface CampAttestationTrustInputArgs {
  campId: string;
  fields: string[];
  actor: string;
  attestedAt: string;
  notes?: string | null;
  values?: Record<string, unknown>;
}

export function buildCampReviewTrustInput(args: CampReviewTrustInputArgs): TrustInput {
  const approved = new Set(args.approvedFields);
  const extractedAt = args.proposalCreatedAt ?? args.reviewedAt;
  const builder = new SurveyInputBuilder({
    source: 'campfit.admin.review',
    generatedAt: args.reviewedAt,
  });

  for (const [field, diff] of Object.entries(args.proposedChanges)) {
    const status: ReviewStatus = approved.has(field) ? 'verified' : 'rejected';
    builder.addObservation(campReviewObservation({
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
    }));
  }

  return validateTrustInput(buildSurveyTrustInput(builder.build()));
}

export function buildCampAttestationTrustInput(args: CampAttestationTrustInputArgs): TrustInput {
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
        sourceRef: `admin:${args.actor}`,
        observedAt: args.attestedAt,
        metadata: {
          trustProducer: 'campfit.admin.attestation',
          notes: args.notes ?? undefined,
        },
      }),
      extraction: {
        extractor: 'campfit-admin',
        extractedAt: args.attestedAt,
        locator: `field:${field}`,
        metadata: {
          reviewKind: 'manual-attestation',
        },
      },
      reviewOutcome: {
        status: 'assumed',
        actor: args.actor,
        reviewedAt: args.attestedAt,
        rationale: args.notes ?? 'Operator reviewed this field and attested the current value.',
      },
      claim: campClaim({
        campId: args.campId,
        field,
        status: 'assumed',
        collectedBy: 'campfit-admin',
        value,
        metadata: {
          reviewKind: 'manual-attestation',
        },
      }),
    }));
  }

  return validateTrustInput(buildSurveyTrustInput(builder.build()));
}

function campReviewObservation(args: {
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
}) {
  return fieldObservation({
    id: campObservationId(args.campId, args.field, args.proposalId),
    field: args.field,
    value: args.diff.new,
    rawSource: webPageSource({
      id: `camp.${args.campId}.field.${args.field}.proposal.${args.proposalId}.source`,
      sourceRef: args.sourceUrl,
      observedAt: args.extractedAt,
      metadata: {
        proposalId: args.proposalId,
        trustProducer: 'campfit.crawl-review',
      },
    }),
    extraction: {
      confidence: args.diff.confidence,
      locator: `field:${args.field}`,
      excerpt: args.diff.excerpt,
      extractor: args.extractionModel ?? 'campfit-crawler',
      extractedAt: args.extractedAt,
      metadata: {
        mode: args.diff.mode,
        oldValue: args.diff.old,
      },
    },
    reviewOutcome: {
      status: args.status,
      actor: args.reviewer,
      reviewedAt: args.reviewedAt,
      rationale: args.reviewerNotes ?? undefined,
      metadata: {
        proposalId: args.proposalId,
      },
    },
    claim: campClaim({
      campId: args.campId,
      field: args.field,
      status: args.status,
      claimType: CAMPFIT_CLAIM_TYPES.scalarFieldCandidate,
      collectedBy: args.extractionModel ?? 'campfit-crawler',
      value: args.diff.new,
      metadata: {
        proposalId: args.proposalId,
        reviewKind: 'crawl-proposal',
        decisionEffect: args.status === 'rejected'
          ? CAMPFIT_DECISION_EFFECTS.keptCurrentValue
          : CAMPFIT_DECISION_EFFECTS.acceptedCandidateValue,
      },
    }),
  });
}

function campClaim(args: {
  campId: string;
  field: string;
  status: ReviewStatus;
  claimType?: CampfitScalarClaimType;
  collectedBy: string;
  value: unknown;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: `camp.${args.campId}.field.${args.field}`,
    subjectType: CAMPFIT_TRUST_SUBJECT_TYPE,
    subjectId: args.campId,
    surface: CAMPFIT_TRUST_SURFACE,
    claimType: args.claimType ?? CAMPFIT_CLAIM_TYPES.scalarField,
    fieldOrBehavior: args.field,
    value: args.value,
    status: args.status,
    impactLevel: 'medium' as const,
    collectedBy: args.collectedBy,
    metadata: args.metadata,
  };
}

function campObservationId(campId: string, field: string, eventId: string): string {
  return `camp.${campId}.field.${field}.${eventId}`;
}
