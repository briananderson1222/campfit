import type { Camp, CampSchedule, RegistrationStatus } from './types';
import type { CampChangeProposal, ProposalStatus } from './admin/types';
import type { ConfidenceBasis, TrustInput, TrustStatus } from '@kontourai/surface';
import {
  buildSurveyTrustInput,
  fieldObservation,
  repeatedObservation,
  SurveyInputBuilder,
  webPageSource,
  type RawSource,
  type SurveyInput,
  type SurveyObservationInput,
} from '@kontourai/survey';

export interface CampfitSurfaceExportInput {
  camp: Pick<Camp, 'id' | 'name' | 'slug' | 'websiteUrl' | 'registrationStatus' | 'fieldSources' | 'lastVerifiedAt' | 'lastCrawledAt' | 'dataConfidence' | 'schedules'>;
  proposal?: Pick<CampChangeProposal, 'id' | 'sourceUrl' | 'proposedChanges' | 'overallConfidence' | 'extractionModel' | 'createdAt' | 'reviewedAt' | 'reviewedBy' | 'status'>;
  generatedAt?: string;
}

type ScalarPublicDataClaimType = 'public-data.field' | 'public-data.field-candidate';
type RepeatedPublicDataClaimType = 'public-data.repeated-field' | 'public-data.repeated-field-candidate';
type CampfitField = 'registrationStatus' | 'schedules';
type ScheduleCandidate = Omit<CampSchedule, 'id'> & { id?: string };

interface ObservationSource {
  sourceRef: string;
  observedAt: string;
  extractedAt: string;
  extractor: string;
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

interface ScalarObservationProjection {
  claimType: ScalarPublicDataClaimType;
  eventMethod: string;
  createdAt: string;
  updatedAt: string;
  actor: string;
  collectedBy: string;
  confidence?: number;
}

interface RepeatedObservationProjection {
  claimType: RepeatedPublicDataClaimType;
  eventMethod: string;
  createdAt: string;
  updatedAt: string;
  actor: string;
  collectedBy: string;
  confidence?: number;
}

interface ScheduleObservationContext<TItem> {
  campId: string;
  claimId: string;
  value: readonly TItem[];
  status: TrustStatus;
  source: ObservationSource;
  review?: ObservationReview;
  projection: RepeatedObservationProjection;
  campfitMetadata: Record<string, unknown>;
}

interface RegistrationStatusObservationContext {
  campId: string;
  claimId: string;
  value: RegistrationStatus;
  status: TrustStatus;
  source: ObservationSource;
  review?: ObservationReview;
  projection: ScalarObservationProjection;
  campfitMetadata: Record<string, unknown>;
}

export function buildCampfitSurfaceTrustInput(input: CampfitSurfaceExportInput): TrustInput {
  return buildSurveyTrustInput(buildCampfitSurveyInput(input));
}

function buildCampfitSurveyInput(input: CampfitSurfaceExportInput): SurveyInput {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const registrationStatusObservations = campfitRegistrationStatusObservations(input, generatedAt);
  const scheduleObservations = campfitScheduleObservations(input, generatedAt);

  return new SurveyInputBuilder({
    source: 'campfit.surface-adapter.public-directory-proof',
    generatedAt,
  })
    .addObservations([
      ...registrationStatusObservations,
      ...scheduleObservations,
    ])
    .build();
}

function campfitRegistrationStatusObservations(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): SurveyObservationInput[] {
  return [
    currentRegistrationObservation(input, generatedAt),
    proposedRegistrationObservation(input, generatedAt),
  ].filter((observation): observation is SurveyObservationInput => observation !== undefined);
}

function campfitScheduleObservations(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): SurveyObservationInput[] {
  return [
    currentScheduleObservation(input, generatedAt),
    proposedScheduleObservation(input, generatedAt),
  ].filter((observation): observation is SurveyObservationInput => observation !== undefined);
}

function toRegistrationStatusObservation(context: RegistrationStatusObservationContext): SurveyObservationInput {
  return fieldObservation<RegistrationStatus>({
    id: context.claimId,
    field: 'registrationStatus',
    value: context.value,
    rawSource: observationWebPageSource(context.source),
    extraction: {
      confidence: context.projection.confidence,
      locator: 'html:field=registrationStatus',
      excerpt: context.source.excerpt,
      extractor: context.source.extractor,
      extractedAt: context.source.extractedAt,
    },
    reviewOutcome: context.review,
    claim: {
      id: context.claimId,
      subjectType: 'public-directory.camp',
      subjectId: context.campId,
      surface: 'public-directory.camp-profile',
      claimType: context.projection.claimType,
      status: context.status,
      createdAt: context.projection.createdAt,
      updatedAt: context.projection.updatedAt,
      impactLevel: 'medium',
      collectedBy: context.projection.collectedBy,
      actor: context.projection.actor,
      eventMethod: context.projection.eventMethod,
      confidenceBasis: confidenceBasisFor(context.status, context.review, context.projection.confidence),
    },
    metadata: {
      campfit: context.campfitMetadata,
    },
  });
}

function toScheduleObservation<TItem>(context: ScheduleObservationContext<TItem>): SurveyObservationInput {
  return repeatedObservation<TItem>({
    id: context.claimId,
    field: 'schedules',
    value: context.value,
    rawSource: observationWebPageSource(context.source),
    extraction: {
      confidence: context.projection.confidence,
      locator: 'html:field=schedules',
      excerpt: context.source.excerpt,
      extractor: context.source.extractor,
      extractedAt: context.source.extractedAt,
    },
    reviewOutcome: context.review,
    claim: {
      id: context.claimId,
      subjectType: 'public-directory.camp',
      subjectId: context.campId,
      surface: 'public-directory.camp-profile',
      claimType: context.projection.claimType,
      status: context.status,
      createdAt: context.projection.createdAt,
      updatedAt: context.projection.updatedAt,
      impactLevel: 'medium',
      collectedBy: context.projection.collectedBy,
      actor: context.projection.actor,
      eventMethod: context.projection.eventMethod,
      confidenceBasis: confidenceBasisFor(context.status, context.review, context.projection.confidence),
    },
    metadata: {
      campfit: context.campfitMetadata,
    },
  });
}

function observationWebPageSource(source: ObservationSource): RawSource {
  return webPageSource({
    id: webPageSourceId(source),
    sourceRef: source.sourceRef,
    observedAt: source.observedAt,
    locatorScheme: 'html',
  });
}

function webPageSourceId(source: ObservationSource): string {
  return stableId(['campfit', 'web-page', source.sourceRef, source.observedAt]);
}

function currentRegistrationObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): SurveyObservationInput {
  const { camp } = input;
  const fieldSource = camp.fieldSources?.registrationStatus;
  const claimId = currentClaimId(camp.id, 'registrationStatus');
  const sourceRef = fieldSource?.sourceUrl ?? camp.websiteUrl;
  const observedAt = fieldSource?.approvedAt ?? camp.lastCrawledAt ?? generatedAt;
  const status = fieldSource?.approvedAt ? 'verified' : camp.registrationStatus === 'UNKNOWN' ? 'unknown' : 'proposed';

  return toRegistrationStatusObservation({
    campId: camp.id,
    claimId,
    value: camp.registrationStatus,
    status,
    source: {
      sourceRef,
      observedAt,
      extractedAt: fieldSource?.approvedAt ?? generatedAt,
      extractor: fieldSource ? 'campfit-field-review' : 'campfit',
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
      createdAt: observedAt,
      eventMethod: fieldSource ? 'field-source-approval' : 'candidate-resolution',
      updatedAt: camp.lastVerifiedAt ?? fieldSource?.approvedAt ?? generatedAt,
      actor: fieldSource ? 'campfit-admin' : 'campfit-crawl',
      collectedBy: fieldSource ? 'campfit-field-review' : 'campfit',
    },
    campfitMetadata: {
      campSlug: camp.slug,
      campName: camp.name,
      dataConfidence: camp.dataConfidence,
      fieldSource,
    },
  });
}

function proposedRegistrationObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): SurveyObservationInput | undefined {
  const proposal = input.proposal;
  const diff = proposal?.proposedChanges.registrationStatus;
  if (!proposal || !diff || !isRegistrationStatus(diff.new)) return undefined;

  const claimId = proposedClaimId(input.camp.id, 'registrationStatus', proposal.id);

  return toRegistrationStatusObservation({
    campId: input.camp.id,
    claimId,
    value: diff.new,
    status: proposalStatus(proposal.status),
    source: {
      sourceRef: diff.sourceUrl ?? proposal.sourceUrl,
      observedAt: proposal.createdAt,
      extractedAt: proposal.createdAt,
      extractor: proposal.extractionModel,
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
      createdAt: proposal.createdAt,
      eventMethod: proposal.status === 'PENDING' ? 'crawl-proposal' : 'field-review',
      updatedAt: proposal.reviewedAt ?? generatedAt,
      actor: proposal.reviewedBy ?? 'campfit-crawl',
      collectedBy: proposal.extractionModel,
      confidence: diff.confidence,
    },
    campfitMetadata: {
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      oldValue: diff.old,
      mode: diff.mode,
      overallConfidence: proposal.overallConfidence,
      extractionModel: proposal.extractionModel,
    },
  });
}

function currentScheduleObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): SurveyObservationInput | undefined {
  const { camp } = input;
  const field = 'schedules';
  const fieldSource = camp.fieldSources?.schedules;
  if (camp.schedules.length === 0 && !fieldSource?.approvedAt) return undefined;

  const claimId = currentClaimId(camp.id, field);
  const observedAt = fieldSource?.approvedAt ?? camp.lastCrawledAt ?? generatedAt;
  const status = fieldSource?.approvedAt ? 'verified' : 'proposed';
  const review = fieldSource?.approvedAt
    ? {
        id: `${claimId}.review.approved`,
        actor: 'campfit-admin',
        reviewedAt: fieldSource.approvedAt,
        status: 'verified' as const,
        rationale: 'Approved schedules field source.',
      }
    : undefined;

  return toScheduleObservation<CampSchedule>({
    campId: camp.id,
    claimId,
    value: camp.schedules,
    status,
    source: {
      sourceRef: fieldSource?.sourceUrl ?? camp.websiteUrl,
      observedAt,
      extractor: fieldSource ? 'campfit-field-review' : 'campfit',
      extractedAt: fieldSource?.approvedAt ?? generatedAt,
      excerpt: fieldSource?.excerpt,
    },
    review,
    projection: {
      claimType: 'public-data.repeated-field',
      createdAt: observedAt,
      updatedAt: camp.lastVerifiedAt ?? fieldSource?.approvedAt ?? generatedAt,
      collectedBy: fieldSource ? 'campfit-field-review' : 'campfit',
      actor: fieldSource ? 'campfit-admin' : 'campfit-crawl',
      eventMethod: fieldSource ? 'field-source-approval' : 'candidate-resolution',
    },
    campfitMetadata: {
      campSlug: camp.slug,
      campName: camp.name,
      dataConfidence: camp.dataConfidence,
      fieldSource,
    },
  });
}

function proposedScheduleObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): SurveyObservationInput | undefined {
  const proposal = input.proposal;
  const diff = proposal?.proposedChanges.schedules;
  if (!proposal || !diff || !isScheduleCandidateArray(diff.new)) return undefined;

  const field = 'schedules';
  const claimId = proposedClaimId(input.camp.id, field, proposal.id);
  const status = proposalStatus(proposal.status);
  const review = proposal.reviewedAt && proposal.reviewedBy
    ? {
        id: `${claimId}.review.${proposal.status.toLowerCase()}`,
        actor: proposal.reviewedBy,
        reviewedAt: proposal.reviewedAt,
        status: proposalReviewStatus(proposal.status),
        rationale: `Proposal ${proposal.status.toLowerCase()} by reviewer.`,
      }
    : undefined;

  return toScheduleObservation<ScheduleCandidate>({
    campId: input.camp.id,
    claimId,
    value: diff.new,
    status,
    source: {
      sourceRef: diff.sourceUrl ?? proposal.sourceUrl,
      observedAt: proposal.createdAt,
      extractor: proposal.extractionModel,
      extractedAt: proposal.createdAt,
      excerpt: diff.excerpt,
      confidence: diff.confidence,
    },
    review,
    projection: {
      claimType: 'public-data.repeated-field-candidate',
      createdAt: proposal.createdAt,
      updatedAt: proposal.reviewedAt ?? generatedAt,
      collectedBy: proposal.extractionModel,
      actor: proposal.reviewedBy ?? 'campfit-crawl',
      eventMethod: proposal.status === 'PENDING' ? 'crawl-proposal' : 'field-review',
      confidence: diff.confidence,
    },
    campfitMetadata: {
      proposalId: proposal.id,
      proposalStatus: proposal.status,
      oldValue: diff.old,
      mode: diff.mode,
      overallConfidence: proposal.overallConfidence,
      extractionModel: proposal.extractionModel,
    },
  });
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

function confidenceBasisFor(
  status: TrustStatus,
  review: ObservationReview | undefined,
  extractionConfidence?: number,
): ConfidenceBasis {
  const hasSupport = review || extractionConfidence !== undefined;

  return {
    sourceQuality: hasSupport ? 'moderate' : 'unknown',
    extractionConfidence,
    reviewerAuthority: status === 'verified' ? 'operator' : 'none',
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

function stableId(parts: Array<string | number>): string {
  return parts.map((part) => String(part).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()).join('.');
}

export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return value === 'OPEN' || value === 'FULL' || value === 'WAITLIST' || value === 'CLOSED' || value === 'COMING_SOON' || value === 'UNKNOWN';
}
