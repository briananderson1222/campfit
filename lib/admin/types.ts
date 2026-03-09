export type CrawlStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type CrawlTrigger = 'MANUAL' | 'SCHEDULED';
export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';
export type ChangeType = 'UPDATE' | 'NEW_CAMP' | 'FIELD_POPULATED';

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
}

export interface FieldDiff {
  old: unknown;
  new: unknown;
  confidence: number;
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
  // joined
  campName?: string;
  campSlug?: string;
  communitySlug?: string;
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
