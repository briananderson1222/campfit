import type { Camp, CampSchedule, FieldSource, RegistrationStatus } from './types';
import type { CampChangeProposal, FieldDiff, ProposalStatus } from './admin/types';
import type { ConfidenceBasis, TrustInput, TrustStatus } from '@kontourai/surface';
import {
  buildSurveyTrustInput,
  SurveyInputBuilder,
  type SurveyInput,
  type SurveyObservationInput,
} from '@kontourai/survey';

export interface CampfitSurfaceExportInput {
  camp: Pick<Camp, 'id' | 'name' | 'slug' | 'websiteUrl' | 'registrationStatus' | 'fieldSources' | 'lastVerifiedAt' | 'lastCrawledAt' | 'dataConfidence' | 'schedules'>;
  proposal?: Pick<CampChangeProposal, 'id' | 'sourceUrl' | 'proposedChanges' | 'overallConfidence' | 'extractionModel' | 'createdAt' | 'reviewedAt' | 'reviewedBy' | 'status'>;
  generatedAt?: string;
}

type PublicDataClaimType = 'public-data.field' | 'public-data.field-candidate' | 'public-data.repeated-field' | 'public-data.repeated-field-candidate';
type CampfitField = 'registrationStatus' | 'schedules';
type ScheduleCandidate = Omit<CampSchedule, 'id'> & { id?: string };
type CampfitObservationValue = RegistrationStatus | CampSchedule[] | ScheduleCandidate[];

interface CampfitObservation {
  ids: {
    claimId: string;
  };
  field: CampfitField;
  value: CampfitObservationValue;
  status: TrustStatus;
  source: ObservationSource;
  review?: ObservationReview;
  projection: ObservationProjection;
  campfitMetadata: Record<string, unknown>;
}

interface ObservationSource {
  sourceRef: string;
  observedAt: string;
  extractedAt: string;
  extractor: string;
  collectedBy: string;
  excerpt?: string | null;
  confidence?: number;
}

interface ObservationReview {
  id: string;
  actor: string;
  reviewedAt: string;
  status: 'verified' | 'rejected' | 'proposed';
  rationale: string;
}

interface ObservationProjection {
  claimType: PublicDataClaimType;
  eventMethod: string;
  updatedAt: string;
  actor: string;
}

export function buildCampfitSurfaceTrustInput(input: CampfitSurfaceExportInput): TrustInput {
  return buildSurveyTrustInput(buildCampfitSurveyInput(input));
}

function buildCampfitSurveyInput(input: CampfitSurfaceExportInput): SurveyInput {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const observations = campfitObservations(input, generatedAt);

  return new SurveyInputBuilder({
    source: 'campfit.surface-adapter.public-directory-proof',
    generatedAt,
  })
    .addObservations(observations.map((observation) => toSurveyObservation(input.camp.id, observation)))
    .build();
}

function campfitObservations(input: CampfitSurfaceExportInput, generatedAt: string): CampfitObservation[] {
  return [
    currentRegistrationObservation(input, generatedAt),
    proposedRegistrationObservation(input, generatedAt),
    currentRepeatedFieldObservation(input, generatedAt, 'schedules', input.camp.schedules),
    proposedRepeatedFieldObservation(input, generatedAt, 'schedules'),
  ].filter((observation): observation is CampfitObservation => observation !== undefined);
}

function toSurveyObservation(campId: string, observation: CampfitObservation): SurveyObservationInput {
  return {
    id: observation.ids.claimId,
    rawSource: {
      sourceRef: observation.source.sourceRef,
      observedAt: observation.source.observedAt,
      kind: 'web-page',
      locatorScheme: 'html',
    },
    extraction: {
      target: observation.field,
      value: observation.value,
      confidence: observation.source.confidence,
      locator: `html:field=${observation.field}`,
      excerpt: observation.source.excerpt ?? `${observation.field}: ${observationValueSummary(observation.value)}`,
      extractor: observation.source.extractor,
      extractedAt: observation.source.extractedAt,
    },
    reviewOutcome: observation.review,
    claim: {
      id: observation.ids.claimId,
      subjectType: 'public-directory.camp',
      subjectId: campId,
      surface: 'public-directory.camp-profile',
      claimType: observation.projection.claimType,
      fieldOrBehavior: observation.field,
      value: observation.value,
      status: observation.status,
      createdAt: observation.source.observedAt,
      updatedAt: observation.projection.updatedAt,
      impactLevel: 'medium',
      collectedBy: observation.source.collectedBy,
      actor: observation.projection.actor,
      eventMethod: observation.projection.eventMethod,
      confidenceBasis: confidenceBasisForObservation(observation),
      metadata: {
        campfit: observation.campfitMetadata,
      },
    },
  };
}

function currentRegistrationObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): CampfitObservation {
  const { camp } = input;
  const fieldSource = camp.fieldSources?.registrationStatus;
  const claimId = currentClaimId(camp.id, 'registrationStatus');
  const sourceRef = fieldSource?.sourceUrl ?? camp.websiteUrl;
  const observedAt = fieldSource?.approvedAt ?? camp.lastCrawledAt ?? generatedAt;
  const status = fieldSource?.approvedAt ? 'verified' : camp.registrationStatus === 'UNKNOWN' ? 'unknown' : 'proposed';

  return {
    ids: { claimId },
    field: 'registrationStatus',
    value: camp.registrationStatus,
    status,
    source: {
      sourceRef,
      observedAt,
      extractedAt: fieldSource?.approvedAt ?? generatedAt,
      extractor: fieldSource ? 'campfit-field-review' : 'campfit',
      collectedBy: fieldSource ? 'campfit-field-review' : 'campfit',
      excerpt: fieldSource?.excerpt,
    },
    review: fieldSource?.approvedAt
      ? {
          id: `${claimId}.review.approved`,
          actor: 'campfit-admin',
          reviewedAt: fieldSource.approvedAt,
          status: 'verified',
          rationale: 'Approved registrationStatus field source.',
        }
      : undefined,
    projection: {
      claimType: 'public-data.field',
      eventMethod: fieldSource ? 'field-source-approval' : 'candidate-resolution',
      updatedAt: camp.lastVerifiedAt ?? fieldSource?.approvedAt ?? generatedAt,
      actor: fieldSource ? 'campfit-admin' : 'campfit-crawl',
    },
    campfitMetadata: {
      campSlug: camp.slug,
      campName: camp.name,
      dataConfidence: camp.dataConfidence,
      fieldSource,
    },
  };
}

function proposedRegistrationObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): CampfitObservation | undefined {
  const proposal = input.proposal;
  const diff = proposal?.proposedChanges.registrationStatus;
  if (!proposal || !diff || !isRegistrationStatus(diff.new)) return undefined;

  const claimId = proposedClaimId(input.camp.id, 'registrationStatus', proposal.id);

  return {
    ids: { claimId },
    field: 'registrationStatus',
    value: diff.new,
    status: proposalStatus(proposal.status),
    source: {
      sourceRef: diff.sourceUrl ?? proposal.sourceUrl,
      observedAt: proposal.createdAt,
      extractedAt: proposal.createdAt,
      extractor: proposal.extractionModel,
      collectedBy: proposal.extractionModel,
      excerpt: diff.excerpt,
      confidence: diff.confidence,
    },
    review: proposal.reviewedAt && proposal.reviewedBy
      ? {
          id: `${claimId}.review.${proposal.status.toLowerCase()}`,
          actor: proposal.reviewedBy,
          reviewedAt: proposal.reviewedAt,
          status: proposalReviewStatus(proposal.status),
          rationale: `Proposal ${proposal.status.toLowerCase()} by reviewer.`,
        }
      : undefined,
    projection: {
      claimType: 'public-data.field-candidate',
      eventMethod: proposal.status === 'PENDING' ? 'crawl-proposal' : 'field-review',
      updatedAt: proposal.reviewedAt ?? generatedAt,
      actor: proposal.reviewedBy ?? 'campfit-crawl',
    },
    campfitMetadata: {
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      oldValue: diff.old,
      mode: diff.mode,
      overallConfidence: proposal.overallConfidence,
      extractionModel: proposal.extractionModel,
    },
  };
}

function currentRepeatedFieldObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
  field: 'schedules',
  value: CampSchedule[],
): CampfitObservation | undefined;
function currentRepeatedFieldObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
  field: 'schedules',
  value: CampSchedule[],
): CampfitObservation | undefined {
  const { camp } = input;
  const fieldSource = camp.fieldSources?.[field];
  if (value.length === 0 && !fieldSource?.approvedAt) return undefined;

  const claimId = currentClaimId(camp.id, field);
  const observedAt = fieldSource?.approvedAt ?? camp.lastCrawledAt ?? generatedAt;

  return {
    ids: { claimId },
    field,
    value,
    status: fieldSource?.approvedAt ? 'verified' : 'proposed',
    source: {
      sourceRef: fieldSource?.sourceUrl ?? camp.websiteUrl,
      observedAt,
      extractedAt: fieldSource?.approvedAt ?? generatedAt,
      extractor: fieldSource ? 'campfit-field-review' : 'campfit',
      collectedBy: fieldSource ? 'campfit-field-review' : 'campfit',
      excerpt: fieldSource?.excerpt,
    },
    review: fieldSource?.approvedAt
      ? {
          id: `${claimId}.review.approved`,
          actor: 'campfit-admin',
          reviewedAt: fieldSource.approvedAt,
          status: 'verified',
          rationale: `Approved ${field} field source.`,
        }
      : undefined,
    projection: {
      claimType: 'public-data.repeated-field',
      eventMethod: fieldSource ? 'field-source-approval' : 'candidate-resolution',
      updatedAt: camp.lastVerifiedAt ?? fieldSource?.approvedAt ?? generatedAt,
      actor: fieldSource ? 'campfit-admin' : 'campfit-crawl',
    },
    campfitMetadata: {
      campSlug: camp.slug,
      campName: camp.name,
      dataConfidence: camp.dataConfidence,
      fieldSource,
      itemCount: value.length,
      representation: 'aggregate-array',
    },
  };
}

function proposedRepeatedFieldObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
  field: 'schedules',
): CampfitObservation | undefined {
  const proposal = input.proposal;
  const diff = proposal?.proposedChanges[field];
  if (!proposal || !diff || !isScheduleCandidateArray(diff.new)) return undefined;

  const claimId = proposedClaimId(input.camp.id, field, proposal.id);

  return {
    ids: { claimId },
    field,
    value: diff.new,
    status: proposalStatus(proposal.status),
    source: {
      sourceRef: diff.sourceUrl ?? proposal.sourceUrl,
      observedAt: proposal.createdAt,
      extractedAt: proposal.createdAt,
      extractor: proposal.extractionModel,
      collectedBy: proposal.extractionModel,
      excerpt: diff.excerpt,
      confidence: diff.confidence,
    },
    review: proposal.reviewedAt && proposal.reviewedBy
      ? {
          id: `${claimId}.review.${proposal.status.toLowerCase()}`,
          actor: proposal.reviewedBy,
          reviewedAt: proposal.reviewedAt,
          status: proposalReviewStatus(proposal.status),
          rationale: `Proposal ${proposal.status.toLowerCase()} by reviewer.`,
        }
      : undefined,
    projection: {
      claimType: 'public-data.repeated-field-candidate',
      eventMethod: proposal.status === 'PENDING' ? 'crawl-proposal' : 'field-review',
      updatedAt: proposal.reviewedAt ?? generatedAt,
      actor: proposal.reviewedBy ?? 'campfit-crawl',
    },
    campfitMetadata: {
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      oldValue: diff.old,
      mode: diff.mode,
      overallConfidence: proposal.overallConfidence,
      extractionModel: proposal.extractionModel,
      itemCount: diff.new.length,
      representation: 'aggregate-array',
    },
  };
}

function isScheduleCandidateArray(value: unknown): value is ScheduleCandidate[] {
  return Array.isArray(value) && value.every(isScheduleCandidate);
}

function isScheduleCandidate(value: unknown): value is ScheduleCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.id === undefined || typeof candidate.id === 'string')
    && typeof candidate.label === 'string'
    && typeof candidate.startDate === 'string'
    && typeof candidate.endDate === 'string'
    && nullableString(candidate.startTime)
    && nullableString(candidate.endTime)
    && nullableString(candidate.earlyDropOff)
    && nullableString(candidate.latePickup);
}

function nullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

function confidenceBasisForObservation(observation: CampfitObservation): ConfidenceBasis {
  const hasSupport = observation.review || observation.source.confidence !== undefined;

  return {
    sourceQuality: hasSupport ? 'moderate' : 'unknown',
    extractionConfidence: observation.source.confidence,
    reviewerAuthority: observation.status === 'verified' ? 'operator' : 'none',
    evidenceStrength: hasSupport ? 'moderate' : 'none',
    impactLevel: 'medium',
  };
}

function proposalStatus(status: ProposalStatus): TrustStatus {
  if (status === 'APPROVED') return 'verified';
  if (status === 'REJECTED') return 'rejected';
  return 'proposed';
}

function proposalReviewStatus(status: ProposalStatus): 'verified' | 'rejected' | 'proposed' {
  if (status === 'APPROVED') return 'verified';
  if (status === 'REJECTED') return 'rejected';
  return 'proposed';
}

function currentClaimId(campId: string, field: CampfitField): string {
  return stableId(['campfit', campId, field, 'current']);
}

function proposedClaimId(campId: string, field: CampfitField, proposalId: string): string {
  return stableId(['campfit', campId, field, proposalId]);
}

function observationValueSummary(value: CampfitObservationValue): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return value;
}

function stableId(parts: Array<string | number>): string {
  return parts.map((part) => String(part).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()).join('.');
}

export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return value === 'OPEN' || value === 'FULL' || value === 'WAITLIST' || value === 'CLOSED' || value === 'COMING_SOON' || value === 'UNKNOWN';
}
