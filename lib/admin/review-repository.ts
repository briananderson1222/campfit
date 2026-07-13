import type { Pool, PoolClient } from 'pg';
import type { SnapshotStore } from '@kontourai/traverse/fetch';

import { getPool } from '@/lib/db';
import type { CampChangeProposal, ProposedChanges, ProposalStatus } from './types';
import { communityScopeSql } from './community-access';
import { getCampFieldTimeline } from './field-metadata';
import { CAMP_SCALAR_FIELDS } from './proposal-fields';
import { deriveFieldCorroboration, type FieldCorroboration, type ProposalHistoryRow } from './claim-corroboration';
import { evaluateShadowAutoAccept } from './shadow-auto-accept';
import { resolveProposalSnapshots } from './shadow-auto-accept-read';

export async function createProposal(opts: {
  campId: string;
  crawlRunId: string;
  sourceUrl: string;
  rawExtraction: Record<string, unknown>;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  extractionModel: string;
  /**
   * Snapshot provenance (migration 015_proposal_snapshot_ref.sql — both
   * columns already exist, nullable). Optional and additive: absent (or
   * explicitly `null`, e.g. when the underlying traverse fetch never
   * captured a snapshot) stays `null` on the row rather than a fabricated
   * value. Populated by both `runCrawlPipeline` strategies as of
   * campfit#97 — see crawl-pipeline.ts's two `createProposal` call sites.
   */
  snapshotRef?: string | null;
  snapshotBodyHash?: string | null;
}): Promise<string> {
  const pool = getPool();

  // Supersede any older PENDING proposals for this camp — newer crawl takes precedence
  await pool.query(
    `UPDATE "CampChangeProposal"
     SET status = 'SKIPPED',
         "reviewerNotes" = COALESCE("reviewerNotes", '') || ' [Superseded by newer crawl]',
         "reviewedAt" = now()
     WHERE "campId" = $1 AND status = 'PENDING'`,
    [opts.campId]
  );

  const result = await pool.query(
    `INSERT INTO "CampChangeProposal"
       ("campId", "crawlRunId", "sourceUrl", "rawExtraction", "proposedChanges", "overallConfidence", "extractionModel", "snapshotRef", "snapshotBodyHash")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [opts.campId, opts.crawlRunId, opts.sourceUrl,
     JSON.stringify(opts.rawExtraction), JSON.stringify(opts.proposedChanges),
     opts.overallConfidence, opts.extractionModel,
     opts.snapshotRef ?? null, opts.snapshotBodyHash ?? null]
  );
  return result.rows[0].id;
}

/**
 * Shared WHERE-clause/param builder for the "pending Camp proposal" base
 * query — factored out of `getPendingProposals` (campfit#51, Wave 2 Task
 * 2.1) so `getRankedReviewQueue` (below) shares the SAME filter semantics
 * (status/minConfidence/campId/providerId/community scope) rather than
 * duplicating them. Returns only the WHERE clause + its positional param
 * values; callers append their own SELECT/JOIN/ORDER BY/LIMIT.
 */
function buildPendingProposalsBaseQuery(opts: {
  minConfidence?: number;
  campId?: string;
  providerId?: string;
  communitySlugs?: string[];
}): { whereClause: string; filterValues: unknown[]; communityScopeClause: string } {
  const { minConfidence = 0, campId, providerId, communitySlugs } = opts;
  const filters = [`p.status = 'PENDING'`, `p."overallConfidence" >= $1`];
  const filterValues: unknown[] = [minConfidence];
  const communityScope = communityScopeSql(communitySlugs, `c."communitySlug"`, filterValues.length + 1);

  if (communityScope.values.length > 0) {
    filterValues.push(...communityScope.values);
  }

  if (campId) {
    filterValues.push(campId);
    filters.push(`p."campId" = $${filterValues.length}`);
  }
  if (providerId) {
    filterValues.push(providerId);
    filters.push(`c."providerId" = $${filterValues.length}`);
  }

  return { whereClause: filters.join(' AND '), filterValues, communityScopeClause: communityScope.clause };
}

const PENDING_PROPOSALS_SELECT = `
  SELECT p.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug",
         c."providerId", c."lastVerifiedAt",
         r."startedAt" AS "crawlStartedAt", r."completedAt" AS "crawlCompletedAt", r.trigger AS "crawlTrigger"
  FROM "CampChangeProposal" p
  JOIN "Camp" c ON c.id = p."campId"
  LEFT JOIN "CrawlRun" r ON r.id = p."crawlRunId"
`;

export async function getPendingProposals(opts: {
  limit?: number;
  offset?: number;
  minConfidence?: number;
  campId?: string;
  providerId?: string;
  communitySlugs?: string[];
}): Promise<{ proposals: CampChangeProposal[]; total: number }> {
  const pool = getPool();
  const { limit = 20, offset = 0 } = opts;
  const { whereClause, filterValues, communityScopeClause } = buildPendingProposalsBaseQuery(opts);
  const rowValues = [...filterValues, limit, offset];

  const [rows, countRow] = await Promise.all([
    pool.query(
      `${PENDING_PROPOSALS_SELECT}
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScopeClause}
       ORDER BY p.priority DESC, p."createdAt" DESC
       LIMIT $${filterValues.length + 1} OFFSET $${filterValues.length + 2}`,
      rowValues
    ),
    pool.query(
      `SELECT COUNT(*)
       FROM "CampChangeProposal" p
       JOIN "Camp" c ON c.id = p."campId"
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScopeClause}`,
      filterValues
    ),
  ]);

  return {
    proposals: rows.rows,
    total: parseInt(countRow.rows[0].count),
  };
}

/**
 * Safety ceiling on the ranked queue's per-lane retrieval (campfit#51 review
 * H2 fix) — mirrors the existing, already-accepted 500-row cap in
 * `getPendingProposalQueue` below (same class of documented limitation, not
 * new debt). The ranked queue needs the FULL pending set (both lanes)
 * rather than one page at a time (see `getRankedReviewQueue`'s own comment
 * for why), so its ceiling is somewhat higher.
 *
 * REVIEW H2 FIX (was: a single confidence-DESC-ordered query capped at this
 * value BEFORE the lane split): that ordering meant a backlog with more
 * than this many PENDING proposals silently DROPPED the lowest-confidence
 * rows from the fetch entirely — inverting the `needsReview` lane's whole
 * purpose (surfacing the riskiest/lowest-confidence proposals first) by
 * making it impossible for the truly lowest-confidence rows to ever be
 * fetched once the backlog outgrew the cap. Fixed by running the
 * cap PER LANE, with each lane's OWN ordering, in `getRankedReviewQueue`
 * (one confidence-DESC-capped query, one confidence-ASC-capped query, then
 * merged before lane-splitting) — see that function's own comment.
 * Exported so a test can override it via `getRankedReviewQueue`'s
 * `safetyCap` param without seeding 1000+ rows.
 */
export const RANKED_QUEUE_SAFETY_CAP = 1000;

/**
 * Bounded per-camp history depth for corroboration derivation
 * (`getCampProposalHistoryBatch`) — avoids an unbounded history scan for a
 * camp with a long crawl history.
 */
const PROPOSAL_HISTORY_DEPTH_PER_CAMP = 20;

/**
 * One query, bounded per-camp via a window function, returning every Camp's
 * recent `CampChangeProposal` history (any status — a rejected/approved
 * prior proposal for the same field/value still corroborates, since
 * corroboration is about independent OBSERVATION agreement, not about the
 * prior proposal's own review outcome) as `deriveFieldCorroboration`'s input
 * shape. Grouped into a `Map<campId, ProposalHistoryRow[]>` in JS.
 */
export async function getCampProposalHistoryBatch(pool: Pool, campIds: string[]): Promise<Map<string, ProposalHistoryRow[]>> {
  const map = new Map<string, ProposalHistoryRow[]>();
  if (campIds.length === 0) return map;

  const { rows } = await pool.query<{
    id: string;
    campId: string;
    proposedChanges: ProposedChanges;
    sourceUrl: string;
    crawlRunId: string | null;
    createdAt: string | Date;
  }>(
    `SELECT id, "campId", "proposedChanges", "sourceUrl", "crawlRunId", "createdAt"
     FROM (
       SELECT id, "campId", "proposedChanges", "sourceUrl", "crawlRunId", "createdAt",
              ROW_NUMBER() OVER (PARTITION BY "campId" ORDER BY "createdAt" DESC) AS rn
       FROM "CampChangeProposal"
       WHERE "campId" = ANY($1::text[])
     ) ranked
     WHERE rn <= $2`,
    [campIds, PROPOSAL_HISTORY_DEPTH_PER_CAMP],
  );

  for (const row of rows) {
    const historyRow: ProposalHistoryRow = {
      id: row.id,
      proposedChanges: row.proposedChanges,
      sourceUrl: row.sourceUrl,
      crawlRunId: row.crawlRunId,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    };
    const existing = map.get(row.campId);
    if (existing) existing.push(historyRow);
    else map.set(row.campId, [historyRow]);
  }

  return map;
}

/** A pending `CampChangeProposal`, annotated with its per-scalar-field exact-corroboration derivation. */
export interface RankedProposal extends CampChangeProposal {
  fieldCorroboration: Record<string, FieldCorroboration>;
  /** Count of this proposal's scalar fields with `fieldCorroboration[field].exact === true`. */
  batchEligibleFieldCount: number;
  /** Advisory shadow-mode result only. No review decision is written from it. */
  shadowAutoAccept: boolean;
}

/**
 * Confidence-ranked, two-lane review queue (campfit#51 R1/R2, Wave 2 Task
 * 2.1). Reuses the SAME already-persisted `CampChangeProposal.overallConfidence`
 * ranking signal `getPendingProposals` already exposes via `ConfidenceBadge` —
 * no new scoring engine. Splits the full pending set (within the given
 * community scope) into:
 *
 *  - `batchReady`: >=1 scalar field claim is exact-corroborated
 *    (`deriveFieldCorroboration`), sorted `priority DESC, overallConfidence
 *    DESC` — safest, fastest to dispose of first.
 *  - `needsReview`: 0 corroborated field claims, sorted `priority DESC,
 *    overallConfidence ASC` — riskiest/lowest-confidence surfaced first, so
 *    limited reviewer attention lands on what most needs scrutiny.
 *
 * REVIEW H2 FIX — lane-aware capping: fetches the retrieval set via TWO
 * queries against the same PENDING/scope filter — one ordered
 * `overallConfidence DESC LIMIT safetyCap` (the batch-ready lane's own
 * ordering), one ordered `overallConfidence ASC LIMIT safetyCap` (the
 * needs-review lane's own ordering) — and merges them (de-duplicated by
 * id) BEFORE deriving corroboration/splitting into lanes. This guarantees
 * both ends of the confidence distribution are always represented in the
 * working set: a backlog bigger than `safetyCap` can no longer make the
 * TRUE lowest-confidence PENDING proposals invisible to `needsReview`
 * (the old single confidence-DESC-ordered query silently dropped exactly
 * those rows once the backlog exceeded the cap — see `RANKED_QUEUE_SAFETY_CAP`'s
 * own comment). Each final, lane-sorted array is ALSO explicitly re-sliced
 * to `safetyCap` (defense in depth — the two source queries already bound
 * the merged set to at most `2 * safetyCap` distinct rows, so a single lane
 * exceeding `safetyCap` after the split would be unusual but is still
 * capped rather than assumed away).
 *
 * `total` is the HONEST count of every PENDING proposal matching the
 * filter (a plain `COUNT(*)`, unbounded by `safetyCap`) — NOT the size of
 * the (possibly-capped) working set actually ranked. `rankedCount` is that
 * working-set size (`batchReady.length + needsReview.length` before
 * `limit`/`offset` pagination), so a caller can render an honest "showing X
 * of Y" signal whenever `rankedCount < total` (see `page.tsx`).
 *
 * `limit`/`offset` are applied to EACH lane independently in JS — an
 * explicit, named simplification since the two lanes are visually separate
 * sections in the UI, not one combined list (pagination is per-lane, not a
 * single combined page).
 */
export async function getRankedReviewQueue(opts: {
  limit?: number;
  offset?: number;
  communitySlugs?: string[];
  /**
   * Deviation from the plan's literally-declared signature (Wave 2 Task
   * 2.1 named only `limit`/`offset`/`communitySlugs`): `campId`/`providerId`
   * are threaded through here too, reusing
   * `buildPendingProposalsBaseQuery`'s existing support for both, so
   * `page.tsx`'s existing `?campId=`/`?providerId=` filtered links (from
   * `camp-editor.tsx`, `camps-table.tsx`, `first-crawl-offer.tsx`,
   * providers' detail page) keep working once the proposals tab switches to
   * this function — dropping them would silently regress those existing
   * filtered views back to an unfiltered full queue. Flagged here rather
   * than silently added with no trace.
   */
  campId?: string;
  providerId?: string;
  /**
   * Override for `RANKED_QUEUE_SAFETY_CAP` (review H2 fix) — a test can
   * lower this to prove lane-aware capping without seeding 1000+ rows.
   * Defaults to the real safety constant in production use.
   */
  safetyCap?: number;
  /** Test seam for a real isolated SnapshotStore; production uses the shared filesystem store. */
  snapshotStore?: SnapshotStore;
}): Promise<{ batchReady: RankedProposal[]; needsReview: RankedProposal[]; total: number; rankedCount: number }> {
  const pool = getPool();
  const { limit, offset = 0, safetyCap = RANKED_QUEUE_SAFETY_CAP } = opts;
  const { whereClause, filterValues, communityScopeClause } = buildPendingProposalsBaseQuery(opts);
  const capParamIndex = filterValues.length + 1;

  const [highConfidenceResult, lowConfidenceResult, countResult] = await Promise.all([
    pool.query<CampChangeProposal>(
      `${PENDING_PROPOSALS_SELECT}
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScopeClause}
       ORDER BY p.priority DESC, p."overallConfidence" DESC
       LIMIT $${capParamIndex}`,
      [...filterValues, safetyCap],
    ),
    pool.query<CampChangeProposal>(
      `${PENDING_PROPOSALS_SELECT}
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScopeClause}
       ORDER BY p.priority DESC, p."overallConfidence" ASC
       LIMIT $${capParamIndex}`,
      [...filterValues, safetyCap],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)
       FROM "CampChangeProposal" p
       JOIN "Camp" c ON c.id = p."campId"
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScopeClause}`,
      filterValues,
    ),
  ]);

  const rowsById = new Map<string, CampChangeProposal>();
  for (const row of [...highConfidenceResult.rows, ...lowConfidenceResult.rows]) {
    rowsById.set(row.id, row);
  }
  const rows = Array.from(rowsById.values());

  const campIds = Array.from(new Set(rows.map((row) => row.campId)));
  const historyByCamp = await getCampProposalHistoryBatch(pool, campIds);

  const snapshotResolutions = await resolveProposalSnapshots(rows, { store: opts.snapshotStore });
  const ranked: RankedProposal[] = rows.map((proposal, index) => {
    const history = historyByCamp.get(proposal.campId) ?? [];
    const fieldCorroboration: Record<string, FieldCorroboration> = {};
    let batchEligibleFieldCount = 0;
    for (const field of Object.keys(proposal.proposedChanges)) {
      if (!CAMP_SCALAR_FIELDS.includes(field)) continue;
      const corroboration = deriveFieldCorroboration({
        targetProposalId: proposal.id,
        targetCrawlRunId: proposal.crawlRunId,
        field,
        history,
      });
      fieldCorroboration[field] = corroboration;
      if (corroboration.exact) batchEligibleFieldCount += 1;
    }
    const snapshotResolved = snapshotResolutions[index] ?? false;
    const shadowAutoAccept = evaluateShadowAutoAccept({
      overallConfidence: proposal.overallConfidence,
      proposedChanges: proposal.proposedChanges,
      snapshotResolved,
    }).wouldAutoAccept;
    return { ...proposal, fieldCorroboration, batchEligibleFieldCount, shadowAutoAccept };
  });

  const batchReady = ranked
    .filter((proposal) => proposal.batchEligibleFieldCount > 0)
    .sort((a, b) => (b.priority - a.priority) || (b.overallConfidence - a.overallConfidence))
    .slice(0, safetyCap);
  const needsReview = ranked
    .filter((proposal) => proposal.batchEligibleFieldCount === 0)
    .sort((a, b) => (b.priority - a.priority) || (a.overallConfidence - b.overallConfidence))
    .slice(0, safetyCap);

  const paginate = (list: RankedProposal[]) => (limit === undefined ? list : list.slice(offset, offset + limit));

  return {
    batchReady: paginate(batchReady),
    needsReview: paginate(needsReview),
    total: parseInt(countResult.rows[0]!.count, 10),
    rankedCount: batchReady.length + needsReview.length,
  };
}

export interface ReviewedShadowProposalRow {
  readonly id: string;
  readonly status: 'APPROVED' | 'REJECTED';
  readonly overallConfidence: number | null;
  readonly proposedChanges: ProposedChanges;
  readonly snapshotRef: string | null;
  readonly snapshotBodyHash: string | null;
}

/** Read-only source rows for the offline shadow precision report. */
export async function getReviewedShadowProposals(): Promise<ReviewedShadowProposalRow[]> {
  const { rows } = await getPool().query<ReviewedShadowProposalRow>(
    `SELECT id, status, "overallConfidence", "proposedChanges", "snapshotRef", "snapshotBodyHash"
     FROM "CampChangeProposal"
     WHERE status IN ('APPROVED', 'REJECTED')
     ORDER BY "createdAt" ASC, id ASC`,
  );
  return rows;
}

export async function getProposal(id: string): Promise<CampChangeProposal | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT p.*,
            c.name AS "campName", c.slug AS "campSlug", c."communitySlug",
            c."providerId", c."lastVerifiedAt",
            r."startedAt" AS "crawlStartedAt", r."completedAt" AS "crawlCompletedAt",
            r.trigger AS "crawlTrigger", r."triggeredBy" AS "crawlTriggeredBy",
            row_to_json(c.*) AS "campData"
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
     LEFT JOIN "CrawlRun" r ON r.id = p."crawlRunId"
     WHERE p.id = $1`,
    [id]
  );
  const proposal = result.rows[0] ?? null;
  if (!proposal) return null;
  proposal.fieldTimeline = await getCampFieldTimeline(proposal.campId).catch(() => ({}));
  // node-postgres parses TIMESTAMPTZ columns into JS Date objects, not the
  // `string`/`string | null` these fields are typed as on CampChangeProposal
  // (createdAt, reviewedAt, crawlStartedAt, crawlCompletedAt). That mismatch
  // was previously invisible because every caller either JSON-serializes the
  // proposal (Date -> ISO string, transparently) or re-wraps a field in
  // `new Date(...)`; it surfaced for createdAt specifically because
  // lib/admin/review-apply.ts forwards it unchanged as `proposalCreatedAt`
  // into buildCampReviewTrustInput, whose @kontourai/surface validation
  // requires a real string and throws "Missing required string field:
  // createdAt" otherwise. Normalize every TIMESTAMPTZ-sourced field on this
  // row the same way (not just createdAt), so the same failure class can't
  // resurface for a sibling field the moment a future caller forwards one of
  // them into a similarly strict validator. Same idiom as
  // survey-review-sessions.ts's `toIsoString`.
  proposal.createdAt = toIsoString(proposal.createdAt);
  proposal.reviewedAt = toIsoStringOrNull(proposal.reviewedAt);
  proposal.crawlStartedAt = toIsoStringOrNull(proposal.crawlStartedAt);
  proposal.crawlCompletedAt = toIsoStringOrNull(proposal.crawlCompletedAt);
  return proposal;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: string | Date | null | undefined): string | null {
  return value == null ? null : toIsoString(value);
}

export async function getPendingProposalQueue(opts: {
  currentId: string;
  campId?: string;
  providerId?: string;
  minConfidence?: number;
  communitySlugs?: string[];
}): Promise<{ previousId: string | null; nextId: string | null }> {
  const { proposals } = await getPendingProposals({
    limit: 500,
    offset: 0,
    campId: opts.campId,
    providerId: opts.providerId,
    minConfidence: opts.minConfidence,
    communitySlugs: opts.communitySlugs,
  });
  const index = proposals.findIndex((proposal) => proposal.id === opts.currentId);
  if (index === -1) return { previousId: null, nextId: null };

  return {
    previousId: proposals[index - 1]?.id ?? null,
    nextId: proposals[index + 1]?.id ?? null,
  };
}

export async function updateProposalStatus(
  id: string,
  status: ProposalStatus,
  reviewedBy: string,
  notes?: string,
  feedbackTags?: string[],
  client?: PoolClient,
): Promise<void> {
  // Optional trailing `client` lets a caller (e.g. lib/admin/review-apply.ts's
  // Review Apply transaction) run this status transition on the same
  // transaction client as the field writes, so the Proposal's status flip is
  // atomic with the writes it authorizes — mirrors the optional-client
  // pattern in survey-review-sessions.ts's findSurveyReviewSession.
  const queryable = client ?? getPool();
  await queryable.query(
    `UPDATE "CampChangeProposal"
     SET status = $1, "reviewedAt" = now(), "reviewedBy" = $2, "reviewerNotes" = $3, "feedbackTags" = $4
     WHERE id = $5`,
    [status, reviewedBy, notes ?? null, feedbackTags ?? null, id]
  );
}

/** Apply some fields and keep proposal PENDING at lower priority. */
export async function partialApprove(
  id: string,
  newAppliedFields: string[],
  reviewedBy: string,
  notes?: string,
  client?: PoolClient,
): Promise<void> {
  // See updateProposalStatus's comment: optional trailing `client` allows
  // this status transition to happen inside the same Review Apply
  // transaction as the field writes it authorizes.
  const queryable = client ?? getPool();
  // Merge new applied fields with any previously applied ones (deduplicate).
  // COALESCE the array_agg itself (F14): when both the row's existing
  // "appliedFields" and newAppliedFields are empty, unnest() over an empty
  // array produces zero rows and array_agg over zero rows is NULL, not
  // '{}' — which would violate the column's NOT NULL constraint (see
  // migration 011) on the very first keepPending call that approves
  // nothing. Falling back to '{}' keeps that a normal, empty-but-valid
  // write instead of a crash.
  await queryable.query(
    `UPDATE "CampChangeProposal"
     SET "appliedFields" = (
           SELECT COALESCE(array_agg(DISTINCT f ORDER BY f), '{}')
           FROM unnest(COALESCE("appliedFields", '{}') || $1::text[]) f
         ),
         "priority"     = -1,
         "reviewedBy"   = $2,
         "reviewerNotes"= COALESCE($3, "reviewerNotes")
     WHERE id = $4`,
    [newAppliedFields, reviewedBy, notes ?? null, id],
  );
}

export interface UnverifiedCamp {
  id: string;
  name: string;
  slug: string;
  communitySlug: string;
  dataConfidence: string;
  websiteUrl: string | null;
  lastVerifiedAt: string | null;
  updatedAt: string;
}

/** Camps that are not VERIFIED and have no pending proposal — need attention. */
export async function getUnverifiedCamps(opts: {
  limit?: number;
  offset?: number;
  communitySlugs?: string[];
}): Promise<{ camps: UnverifiedCamp[]; total: number }> {
  const pool = getPool();
  const { limit = 50, offset = 0, communitySlugs } = opts;
  const communityScope = communityScopeSql(communitySlugs, `c."communitySlug"`, 1);
  const countCommunityScope = communityScopeSql(communitySlugs, `c."communitySlug"`, 1);

  const base = `FROM "Camp" c
    WHERE c."dataConfidence" != 'VERIFIED'
      AND c."archivedAt" IS NULL
      ${communityScope.clause.trim()}
      AND NOT EXISTS (
        SELECT 1 FROM "CampChangeProposal" p
        WHERE p."campId" = c.id AND p.status = 'PENDING'
      )`;

  const [rows, countRow] = await Promise.all([
    pool.query(
      `SELECT c.id, c.name, c.slug, c."communitySlug", c."dataConfidence",
              c."websiteUrl", c."lastVerifiedAt", c."updatedAt"
       ${base}
       ORDER BY c."dataConfidence" ASC, c."updatedAt" ASC
       LIMIT $${communityScope.values.length + 1} OFFSET $${communityScope.values.length + 2}`,
      [...communityScope.values, limit, offset]
    ),
    pool.query(`SELECT COUNT(*) ${base.replace(communityScope.clause, countCommunityScope.clause)}`, countCommunityScope.values),
  ]);

  return { camps: rows.rows, total: parseInt(countRow.rows[0].count) };
}

export async function getPendingCount(communitySlugs?: string[]): Promise<number> {
  const pool = getPool();
  const communityScope = communityScopeSql(communitySlugs, `c."communitySlug"`, 1);
  const result = await pool.query(
    `SELECT COUNT(*)
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
     WHERE p.status = 'PENDING'${communityScope.clause} AND c."archivedAt" IS NULL`,
    communityScope.values,
  );
  return parseInt(result.rows[0].count);
}

export interface CampReport {
  id: string;
  campId: string;
  campName: string;
  campSlug: string;
  communitySlug: string;
  userId: string | null;
  userEmail: string | null;
  type: 'WRONG_INFO' | 'MISSING_INFO' | 'CAMP_CLOSED' | 'OTHER';
  description: string;
  status: 'PENDING' | 'REVIEWED' | 'DISMISSED';
  adminNotes: string | null;
  createdAt: string;
}

export async function getPendingReports(opts: {
  limit?: number;
  offset?: number;
  communitySlugs?: string[];
}): Promise<{ reports: CampReport[]; total: number }> {
  const pool = getPool();
  const { limit = 25, offset = 0, communitySlugs } = opts;
  const communityScope = communityScopeSql(communitySlugs, `c."communitySlug"`, 1);

  const [rows, countRow] = await Promise.all([
    pool.query(
      `SELECT r.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug"
       FROM "CampReport" r
       JOIN "Camp" c ON c.id = r."campId"
       WHERE r.status = 'PENDING'${communityScope.clause}
       ORDER BY r."createdAt" DESC
       LIMIT $${communityScope.values.length + 1} OFFSET $${communityScope.values.length + 2}`,
      [...communityScope.values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)
       FROM "CampReport" r
       JOIN "Camp" c ON c.id = r."campId"
       WHERE r.status = 'PENDING'${communityScope.clause}`,
      communityScope.values,
    ),
  ]);

  return { reports: rows.rows, total: parseInt(countRow.rows[0].count) };
}
