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
  /** Extraction notes an operator must see even when no proposal was created (e.g. a dropped price tier). */
  warnings?: string[];
  /**
   * Fields this run read differently from the stored value but did not
   * propose, because a reviewer approved them from this same page text. A
   * `no_changes` entry with this set is not "the page agrees with the data".
   */
  notProposedAgain?: string[];
  /**
   * Present when the extraction did not read all of the page's text
   * (Traverse's partial reason, and how many text ranges were not fully read).
   * An `ok`/`no_changes` entry with this set is an incomplete run, not a
   * complete one; entries written before this field existed never carry it.
   */
  incomplete?: {
    reason: string;
    unreadRanges: number;
    /** An answer stopped at the provider's output cap (Traverse `output-truncated`). Absent on entries written before it was recorded. */
    outputTruncated?: boolean;
    /** List fields whose updates this run withheld (it did not read the whole page). */
    withheldListFields?: string[];
    /** Empty list fields this run filled from its partial read (they may be missing entries). */
    populatedListFields?: string[];
  };
  /** Whether `model` was reported by the provider or is only the configured id. Absent when the provider did not say, and on older entries. */
  modelSource?: 'provider-reported' | 'configured';
  /**
   * How much of the page's prepared text the extraction read, for every
   * extraction (complete or not): text ranges in total, fully read, not read,
   * and cut off at the provider's output cap. Absent when no extraction ran
   * (an error, or an unchanged page) and on older entries.
   */
  coverage?: { ranges: number; complete: number; unread: number; outputTruncated: number };
  /** The page was fetched and found unchanged, so no extraction ran: `not_modified` is an HTTP 304, `content_unchanged` is the same text as the last complete extraction. */
  skipped?: 'not_modified' | 'content_unchanged';
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
  /** Extractor's self-reported confidence, for ranking only. Absent = not reported (unknown), never 0. */
  confidence?: number;
  /** True when this change contradicts a value a reviewer approved recently (see diff-engine.ts). */
  contradictsRecentApproval?: boolean;
  /** ISO timestamp of the approval this change contradicts; set with contradictsRecentApproval. */
  recentApprovalAt?: string;
  excerpt?: string;     // verbatim snippet from source page supporting this value
  /**
   * `chars:<start>-<end>` of `excerpt` within the prepared text the extraction
   * read (the proposal's `rawExtraction.preparedArtifact`). Absent on proposals
   * written before it was recorded; those resolve by a unique text match.
   */
  locator?: string;
  sourceUrl?: string;   // URL of the page the excerpt was found on
  /**
   * For a list field, where each proposed row was read: one entry per row of
   * `new`, in order. `excerpt` above is only the first row's. Absent on
   * proposals written before it was recorded; such a list has no per-row
   * citation to check.
   */
  rowCitations?: {
    excerpt: string;
    locator?: string;
    /** Sessions only: where the row's start and end time were read. Present only when the crawl stated the time. */
    times?: { excerpt: string; locator?: string }[];
    /** Sessions only: the time is the page's one daily time applied to every session; the page line it was read from. */
    timePageWide?: string;
  }[];
  mode?: 'update' | 'populate' | 'add_items'; // populate = was empty, add_items = array additions
}

export interface FieldSource {
  excerpt: string | null;
  sourceUrl: string;
  approvedAt: string; // ISO timestamp
  /** Fingerprint of the page text the approved proposal was read from. Absent on approvals recorded before it was kept. */
  contentFingerprint?: string;
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
  // Snapshot provenance (additive, nullable — migration 015_proposal_snapshot_ref.sql).
  // Populated by both `runCrawlPipeline` strategies (camp re-crawl and
  // source sweep) at proposal-creation time — see `lib/ingestion/
  // crawl-pipeline.ts`'s two `createProposal` call sites (campfit#97,
  // write side of campfit#91's review-provenance-validation slice). `null`
  // only when the underlying traverse fetch never captured a snapshot.
  // `snapshotRef` is a `traverse-snapshot:<sourceId>?url=...&sha256=...&fetchedAt=...`
  // string parseable by `@kontourai/traverse/fetch`'s `parseSnapshotSourceRef`.
  snapshotRef?: string | null;
  snapshotBodyHash?: string | null;
  // joined from Camp
  campName?: string;
  campSlug?: string;
  communitySlug?: string;
  providerId?: string | null;
  lastVerifiedAt?: string | null;
  campData?: Record<string, unknown>; // full camp row for context
  fieldTimeline?: Record<string, { lastUpdatedAt: string | null; lastAttestedAt: string | null }>;
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

export interface ProviderChangeLog {
  id: string;
  providerId: string;
  changedAt: string;
  changedBy: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: ChangeType;
}

export interface PersonChangeLog {
  id: string;
  personId: string;
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
  /** traverse's `ExtractionResult.totalTokensUsed` (0.8.0) — summed across every chunk's provider call, not just the last one. */
  tokensUsed: number;
  /** traverse's `ExtractionResult.providerCalls` (0.8.0) — calls issued across every chunk (see `metrics-repository.ts`'s `provider_calls` metric). */
  providerCalls: number;
  extractedAt: string;
  error?: string;
  /**
   * Non-fatal traverse warnings (`TraverseRecrawlResult.warnings` — fetch-
   * level warnings plus `ExtractionResult.warnings`, e.g. a
   * `maxProviderCalls`/`maxTotalTokens` cost-guard ceiling stop). Present
   * (non-empty) only when the run produced 1+ warnings. Added so a
   * ceiling-triggered truncation on the re-crawl path (previously invisible
   * on this shape — campfit#71 code review) is now traceable wherever this
   * result is persisted/read.
   */
  warnings?: string[];
}

export type CrawlProgressEvent =
  | { type: 'started'; runId: string; totalCamps: number }
  | { type: 'camp_processing'; campId: string; campName: string; index: number }
  | { type: 'camp_done'; campId: string; proposalId: string | null; confidence: number; changesFound: number; incomplete?: boolean }
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
