export type CrawlStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type CrawlTrigger = 'MANUAL' | 'SCHEDULED';
export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
export type ChangeType = 'UPDATE' | 'NEW_CAMP' | 'FIELD_POPULATED';

export interface CrawlCampLogEntry {
  campId: string;
  campName: string;
  url: string;
  status: 'ok' | 'error' | 'no_changes';
  model: string;
  proposals: number;
  fieldsChanged: string[];
  error?: string;
  durationMs: number;
  processedAt: string; // ISO
}

export interface CrawlRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: CrawlStatus;
  totalCamps: number;
  processedCamps: number;
  errorCount: number;
  newProposals: number;
  trigger: CrawlTrigger;
  triggeredBy: string | null;
  campIds: string[] | null;
  errorLog: { campId: string; error: string; url: string }[];
  campLog: CrawlCampLogEntry[];
}

export interface FieldDiff {
  old: unknown;
  new: unknown;
  confidence: number;
  excerpt?: string;     // verbatim snippet from source page supporting this value
  sourceUrl?: string;   // URL of the page the excerpt was found on
  mode?: 'update' | 'populate' | 'add_items'; // populate = was empty, add_items = array additions
}

export interface FieldSource {
  excerpt: string | null;
  sourceUrl: string;
  approvedAt: string; // ISO timestamp
}

export type ProposedChanges = Record<string, FieldDiff>;

export interface CampChangeProposal {
  id: string;
  campId: string;
  crawlRunId: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  status: ProposalStatus;
  sourceUrl: string;
  rawExtraction: Record<string, unknown>;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  extractionModel: string;
  reviewerNotes: string | null;
  feedbackTags: string[] | null;
  // partial-approval state
  priority: number;             // 0 = fresh, -1 = partially reviewed (sinks in queue)
  appliedFields: string[];      // fields already applied in previous partial approvals
  // joined from Camp
  campName?: string;
  campSlug?: string;
  communitySlug?: string;
  providerId?: string | null;
  lastVerifiedAt?: string | null;
  campData?: Record<string, unknown>; // full camp row for context
  // joined from CrawlRun
  crawlStartedAt?: string;
  crawlCompletedAt?: string | null;
  crawlTrigger?: string;
  crawlTriggeredBy?: string;
}

export interface ProviderChangeProposal {
  id: string;
  providerId: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  status: ProposalStatus;
  sourceUrl: string;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  reviewerNotes: string | null;
  providerName?: string;
  providerSlug?: string;
  communitySlug?: string;
  providerData?: Record<string, unknown>;
}

export interface CampChangeLog {
  id: string;
  campId: string;
  proposalId: string | null;
  changedAt: string;
  changedBy: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: ChangeType;
}

export interface CrawlMetric {
  id: string;
  recordedAt: string;
  crawlRunId: string | null;
  metricName: string;
  metricValue: number;
  dimensions: Record<string, string> | null;
}

export interface LLMExtractionResult {
  extracted: Partial<import('@/lib/ingestion/adapter').CampInput>;
  confidence: Record<string, number>;
  excerpts: Record<string, string>; // per-field verbatim source snippets
  overallConfidence: number;
  rawResponse: string;
  model: string;
  tokensUsed: number;
  extractedAt: string;
  error?: string;
}

export type CrawlProgressEvent =
  | { type: 'started'; runId: string; totalCamps: number }
  | { type: 'camp_processing'; campId: string; campName: string; index: number }
  | { type: 'camp_done'; campId: string; proposalId: string | null; confidence: number; changesFound: number }
  | { type: 'camp_error'; campId: string; campName: string; error: string }
  | { type: 'completed'; runId: string; stats: Pick<CrawlRun, 'processedCamps' | 'errorCount' | 'newProposals'> }
  | { type: 'failed'; runId: string; error: string };

export interface AdminDashboardData {
  pendingReviewCount: number;
  recentRuns: CrawlRun[];
  approvalRate: number;
  avgConfidence: number;
  mostChangedFields: { field: string; count: number }[];
  siteFailureRates: { host: string; failureRate: number; total: number }[];
}
