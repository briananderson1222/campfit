import type { Camp, FieldSource, RegistrationStatus } from './types';
import type { CampChangeProposal, FieldDiff } from './admin/types';
import type { Claim, Evidence, TrustInput, TrustStatus, VerificationEvent } from '@kontourai/surface';

export interface CampfitSurfaceExportInput {
  camp: Pick<Camp, 'id' | 'name' | 'slug' | 'websiteUrl' | 'registrationStatus' | 'fieldSources' | 'lastVerifiedAt' | 'lastCrawledAt' | 'dataConfidence'>;
  proposal?: Pick<CampChangeProposal, 'id' | 'sourceUrl' | 'proposedChanges' | 'overallConfidence' | 'extractionModel' | 'createdAt' | 'reviewedAt' | 'reviewedBy' | 'status'>;
  generatedAt?: string;
}

export function buildCampfitSurfaceTrustInput(input: CampfitSurfaceExportInput): TrustInput {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const claims: Claim[] = [];
  const evidence: Evidence[] = [];
  const events: VerificationEvent[] = [];

  addCurrentRegistrationStatus({ input, generatedAt, claims, evidence, events });
  addProposedRegistrationStatus({ input, generatedAt, claims, evidence, events });

  return {
    schemaVersion: 3,
    source: 'campfit.surface-adapter.registration-status-proof',
    claims,
    evidence,
    policies: [],
    events,
  };
}

function addCurrentRegistrationStatus(args: {
  input: CampfitSurfaceExportInput;
  generatedAt: string;
  claims: Claim[];
  evidence: Evidence[];
  events: VerificationEvent[];
}): void {
  const { camp } = args.input;
  const fieldSource = camp.fieldSources?.registrationStatus;
  const claimId = currentClaimId(camp.id);
  const status: TrustStatus = fieldSource?.approvedAt ? 'verified' : camp.registrationStatus === 'UNKNOWN' ? 'unknown' : 'proposed';
  args.claims.push({
    id: claimId,
    subjectType: 'public-directory.camp',
    subjectId: camp.id,
    surface: 'public-directory.camp-profile',
    claimType: 'public-data.field',
    fieldOrBehavior: 'registrationStatus',
    value: camp.registrationStatus,
    status,
    createdAt: fieldSource?.approvedAt ?? camp.lastCrawledAt ?? args.generatedAt,
    updatedAt: camp.lastVerifiedAt ?? fieldSource?.approvedAt ?? args.generatedAt,
    impactLevel: 'medium',
    confidenceBasis: {
      sourceQuality: fieldSource ? 'moderate' : 'unknown',
      reviewerAuthority: fieldSource ? 'operator' : 'none',
      evidenceStrength: fieldSource ? 'moderate' : 'none',
      impactLevel: 'medium',
    },
    metadata: {
      campfit: {
        campSlug: camp.slug,
        campName: camp.name,
        dataConfidence: camp.dataConfidence,
        fieldSource,
      },
      surveyCandidate: {
        rawSourceId: fieldSource?.sourceUrl,
        extractionId: fieldSource ? `${camp.id}:registrationStatus:approved-source` : undefined,
        resolvedValueId: `${camp.id}:registrationStatus:current`,
        reviewOutcomeId: fieldSource?.approvedAt ? `${camp.id}:registrationStatus:approved` : undefined,
      },
    },
  });

  if (!fieldSource) return;
  const evidenceId = `${claimId}.evidence.source`;
  args.evidence.push(fieldSourceEvidence({ claimId, evidenceId, fieldSource, camp, generatedAt: args.generatedAt }));
  args.events.push({
    id: `${claimId}.event.verified`,
    claimId,
    status: 'verified',
    actor: 'campfit-admin',
    method: 'field-source-approval',
    evidenceIds: [evidenceId],
    createdAt: fieldSource.approvedAt,
    verifiedAt: fieldSource.approvedAt,
    notes: 'Approved registrationStatus field source.',
  });
}

function addProposedRegistrationStatus(args: {
  input: CampfitSurfaceExportInput;
  generatedAt: string;
  claims: Claim[];
  evidence: Evidence[];
  events: VerificationEvent[];
}): void {
  const proposal = args.input.proposal;
  const diff = proposal?.proposedChanges.registrationStatus;
  if (!proposal || !diff) return;

  const claimId = proposedClaimId(args.input.camp.id, proposal.id);
  args.claims.push({
    id: claimId,
    subjectType: 'public-directory.camp',
    subjectId: args.input.camp.id,
    surface: 'public-directory.camp-profile',
    claimType: 'public-data.field-candidate',
    fieldOrBehavior: 'registrationStatus',
    value: diff.new,
    status: proposal.status === 'APPROVED' ? 'verified' : proposal.status === 'REJECTED' ? 'rejected' : 'proposed',
    createdAt: proposal.createdAt,
    updatedAt: proposal.reviewedAt ?? args.generatedAt,
    impactLevel: 'medium',
    confidenceBasis: {
      sourceQuality: 'moderate',
      extractionConfidence: diff.confidence,
      reviewerAuthority: proposal.status === 'APPROVED' ? 'operator' : 'none',
      evidenceStrength: 'moderate',
      impactLevel: 'medium',
    },
    metadata: {
      campfit: {
        proposalId: proposal.id,
        proposalStatus: proposal.status,
        oldValue: diff.old,
        mode: diff.mode,
        overallConfidence: proposal.overallConfidence,
        extractionModel: proposal.extractionModel,
      },
      surveyCandidate: {
        rawSourceId: diff.sourceUrl ?? proposal.sourceUrl,
        extractionId: `${proposal.id}:registrationStatus`,
        resolvedValueId: `${proposal.id}:registrationStatus:candidate`,
        reviewOutcomeId: proposal.reviewedAt ? `${proposal.id}:registrationStatus:${proposal.status.toLowerCase()}` : undefined,
      },
    },
  });

  const evidenceId = `${claimId}.evidence.crawl`;
  args.evidence.push(diffEvidence({ claimId, evidenceId, diff, proposal, generatedAt: args.generatedAt }));
  args.events.push({
    id: `${claimId}.event.${proposal.status.toLowerCase()}`,
    claimId,
    status: proposal.status === 'APPROVED' ? 'verified' : proposal.status === 'REJECTED' ? 'rejected' : 'proposed',
    actor: proposal.reviewedBy ?? 'campfit-crawl',
    method: proposal.status === 'PENDING' ? 'crawl-proposal' : 'field-review',
    evidenceIds: [evidenceId],
    createdAt: proposal.reviewedAt ?? proposal.createdAt,
    verifiedAt: proposal.status === 'APPROVED' ? proposal.reviewedAt ?? args.generatedAt : undefined,
    notes: proposal.status === 'PENDING'
      ? 'Crawl proposed a registrationStatus candidate awaiting review.'
      : `Proposal ${proposal.status.toLowerCase()} by reviewer.`,
  });
}

function fieldSourceEvidence(input: {
  claimId: string;
  evidenceId: string;
  fieldSource: FieldSource;
  camp: Pick<Camp, 'websiteUrl'>;
  generatedAt: string;
}): Evidence {
  return {
    id: input.evidenceId,
    claimId: input.claimId,
    evidenceType: 'crawl_observation',
    method: 'extraction',
    sourceRef: input.fieldSource.sourceUrl || input.camp.websiteUrl,
    sourceLocator: 'html:field=registrationStatus',
    excerptOrSummary: input.fieldSource.excerpt ?? 'registrationStatus approved from public source.',
    observedAt: input.fieldSource.approvedAt,
    collectedBy: 'campfit-field-review',
    metadata: {
      approvedAt: input.fieldSource.approvedAt,
      generatedAt: input.generatedAt,
    },
  };
}

function diffEvidence(input: {
  claimId: string;
  evidenceId: string;
  diff: FieldDiff;
  proposal: Pick<CampChangeProposal, 'sourceUrl' | 'extractionModel' | 'createdAt'>;
  generatedAt: string;
}): Evidence {
  return {
    id: input.evidenceId,
    claimId: input.claimId,
    evidenceType: 'crawl_observation',
    method: 'extraction',
    sourceRef: input.diff.sourceUrl ?? input.proposal.sourceUrl,
    sourceLocator: 'html:field=registrationStatus',
    excerptOrSummary: input.diff.excerpt ?? `registrationStatus candidate: ${String(input.diff.new)}`,
    observedAt: input.proposal.createdAt,
    collectedBy: input.proposal.extractionModel,
    metadata: {
      confidence: input.diff.confidence,
      generatedAt: input.generatedAt,
    },
  };
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
