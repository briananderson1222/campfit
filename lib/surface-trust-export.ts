import type { Camp, FieldSource, RegistrationStatus } from './types';
import type { CampChangeProposal, FieldDiff, ProposalStatus } from './admin/types';
import type { ConfidenceBasis, TrustInput, TrustStatus } from '@kontourai/surface';
import {
  buildSurveyTrustInput,
  SurveyInputBuilder,
  type Candidate,
  type CandidateSet,
  type ClaimTarget,
  type Extraction,
  type RawSource,
  type ReviewOutcome,
  type SurveyClaimRecord,
  type SurveyInput,
} from '@kontourai/survey';

export interface CampfitSurfaceExportInput {
  camp: Pick<Camp, 'id' | 'name' | 'slug' | 'websiteUrl' | 'registrationStatus' | 'fieldSources' | 'lastVerifiedAt' | 'lastCrawledAt' | 'dataConfidence'>;
  proposal?: Pick<CampChangeProposal, 'id' | 'sourceUrl' | 'proposedChanges' | 'overallConfidence' | 'extractionModel' | 'createdAt' | 'reviewedAt' | 'reviewedBy' | 'status'>;
  generatedAt?: string;
}

type RegistrationClaimType = 'public-data.field' | 'public-data.field-candidate';

interface RegistrationObservation {
  ids: ObservationIds;
  value: RegistrationStatus;
  status: TrustStatus;
  source: ObservationSource;
  review?: ObservationReview;
  projection: ObservationProjection;
  campfitMetadata: Record<string, unknown>;
}

interface ObservationIds {
  claimId: string;
  sourceId: string;
  extractionId: string;
  candidateId: string;
  candidateSetId: string;
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
  claimType: RegistrationClaimType;
  eventMethod: string;
  updatedAt: string;
  actor: string;
}

export function buildCampfitSurfaceTrustInput(input: CampfitSurfaceExportInput): TrustInput {
  return buildSurveyTrustInput(buildCampfitSurveyInput(input));
}

function buildCampfitSurveyInput(input: CampfitSurfaceExportInput): SurveyInput {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const observations = registrationObservations(input, generatedAt);

  return new SurveyInputBuilder({
    source: 'campfit.surface-adapter.registration-status-proof',
    generatedAt,
  })
    .addClaimRecords(observations.map((observation) => toSurveyClaimRecord(input.camp.id, observation)))
    .build();
}

function registrationObservations(input: CampfitSurfaceExportInput, generatedAt: string): RegistrationObservation[] {
  return [
    currentRegistrationObservation(input, generatedAt),
    proposedRegistrationObservation(input, generatedAt),
  ].filter((observation): observation is RegistrationObservation => observation !== undefined);
}

function toSurveyClaimRecord(campId: string, observation: RegistrationObservation): SurveyClaimRecord {
  return {
    rawSource: toRawSource(observation),
    extraction: toExtraction(observation),
    candidateSet: toCandidateSet(observation),
    reviewOutcome: observation.review ? toReviewOutcome(observation) : undefined,
    claim: toClaimTarget(campId, observation),
  };
}

function currentRegistrationObservation(
  input: CampfitSurfaceExportInput,
  generatedAt: string,
): RegistrationObservation {
  const { camp } = input;
  const fieldSource = camp.fieldSources?.registrationStatus;
  const claimId = currentClaimId(camp.id);
  const sourceRef = fieldSource?.sourceUrl ?? camp.websiteUrl;
  const observedAt = fieldSource?.approvedAt ?? camp.lastCrawledAt ?? generatedAt;
  const status = fieldSource?.approvedAt ? 'verified' : camp.registrationStatus === 'UNKNOWN' ? 'unknown' : 'proposed';

  return {
    ids: idsForClaim(claimId),
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
): RegistrationObservation | undefined {
  const proposal = input.proposal;
  const diff = proposal?.proposedChanges.registrationStatus;
  if (!proposal || !diff || !isRegistrationStatus(diff.new)) return undefined;

  const claimId = proposedClaimId(input.camp.id, proposal.id);

  return {
    ids: idsForClaim(claimId),
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

function toRawSource(observation: RegistrationObservation): RawSource {
  return {
    id: observation.ids.sourceId,
    kind: 'web-page',
    sourceRef: observation.source.sourceRef,
    observedAt: observation.source.observedAt,
    locatorScheme: 'html',
  };
}

function toExtraction(observation: RegistrationObservation): Extraction {
  return {
    id: observation.ids.extractionId,
    sourceId: observation.ids.sourceId,
    target: 'registrationStatus',
    value: observation.value,
    confidence: observation.source.confidence,
    locator: 'html:field=registrationStatus',
    excerpt: observation.source.excerpt ?? `registrationStatus: ${observation.value}`,
    extractor: observation.source.extractor,
    extractedAt: observation.source.extractedAt,
  };
}

function toCandidateSet(observation: RegistrationObservation): CandidateSet {
  return {
    id: observation.ids.candidateSetId,
    target: 'registrationStatus',
    selectedCandidateId: observation.ids.candidateId,
    status: observation.status === 'proposed' ? 'needs-review' : 'resolved',
    candidates: [toCandidate(observation)],
  };
}

function toCandidate(observation: RegistrationObservation): Candidate {
  return {
    id: observation.ids.candidateId,
    extractionId: observation.ids.extractionId,
    value: observation.value,
    confidence: observation.source.confidence,
  };
}

function toReviewOutcome(observation: RegistrationObservation): ReviewOutcome {
  const review = observation.review;
  if (!review) throw new Error(`Missing review for ${observation.ids.claimId}`);

  return {
    id: review.id,
    candidateSetId: observation.ids.candidateSetId,
    candidateId: observation.ids.candidateId,
    status: review.status,
    actor: review.actor,
    reviewedAt: review.reviewedAt,
    rationale: review.rationale,
  };
}

function toClaimTarget(campId: string, observation: RegistrationObservation): ClaimTarget {
  return {
    id: observation.ids.claimId,
    candidateSetId: observation.ids.candidateSetId,
    candidateId: observation.ids.candidateId,
    subjectType: 'public-directory.camp',
    subjectId: campId,
    surface: 'public-directory.camp-profile',
    claimType: observation.projection.claimType,
    fieldOrBehavior: 'registrationStatus',
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
  };
}

function confidenceBasisForObservation(observation: RegistrationObservation): ConfidenceBasis {
  const hasSupport = observation.review || observation.source.confidence !== undefined;

  return {
    sourceQuality: hasSupport ? 'moderate' : 'unknown',
    extractionConfidence: observation.source.confidence,
    reviewerAuthority: observation.status === 'verified' ? 'operator' : 'none',
    evidenceStrength: hasSupport ? 'moderate' : 'none',
    impactLevel: 'medium',
  };
}

function idsForClaim(claimId: string): ObservationIds {
  return {
    claimId,
    sourceId: `${claimId}.source`,
    extractionId: `${claimId}.extraction`,
    candidateId: `${claimId}.candidate`,
    candidateSetId: `${claimId}.candidates`,
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

function currentClaimId(campId: string): string {
  return stableId(['campfit', campId, 'registration-status', 'current']);
}

function proposedClaimId(campId: string, proposalId: string): string {
  return stableId(['campfit', campId, 'registration-status', proposalId]);
}

function stableId(parts: Array<string | number>): string {
  return parts.map((part) => String(part).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()).join('.');
}

export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return value === 'OPEN' || value === 'FULL' || value === 'WAITLIST' || value === 'CLOSED' || value === 'COMING_SOON' || value === 'UNKNOWN';
}
