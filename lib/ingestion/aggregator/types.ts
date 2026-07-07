/**
 * lib/ingestion/aggregator/types.ts — the AggregatorSource contract
 * (campfit#93).
 *
 * An AggregatorSource is a third-party camp-listing site an admin has
 * registered for candidate discovery. It is structurally distinct from the
 * OLDER, unrelated `lib/ingestion/aggregator/base-harvester.ts` harvester
 * concept (which scrapes a fixed aggregator and creates Camp stubs directly,
 * with no review queue and no ToS gate) — this module feeds the SAME
 * `ProviderCandidate` human-review queue the curated-source discovery lane
 * (I22/#52) already uses, via a repository-enforced ToS-decision gate
 * (`canFetchAggregator`, see aggregator-repository.ts) rather than creating
 * anything directly.
 */

export interface AggregatorSourceRow {
  id: string;
  name: string;
  url: string;
  communitySlug: string;
  maxPages: number;
  maxDepth: number;
  status: "REGISTERED" | "ACTIVE" | "DECLINED";
  /** NULL until a human records the ToS review decision — THE fetch gate. */
  tosDecision: "APPROVED" | "DECLINED" | null;
  tosReviewedBy: string | null;
  tosReviewedAt: Date | null;
  tosNotes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAggregatorSourceInput {
  name: string;
  url: string;
  communitySlug?: string;
  maxPages?: number;
  maxDepth?: number;
  createdBy?: string | null;
}

export interface TosDecisionInput {
  decision: "APPROVED" | "DECLINED";
  reviewedBy: string;
  notes?: string | null;
}
