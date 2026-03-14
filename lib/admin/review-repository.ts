import { getPool } from '@/lib/db';
import type { CampChangeProposal, ProposedChanges, ProposalStatus } from './types';
import { communityScopeSql } from './community-access';
import { getCampFieldTimeline } from './field-metadata';

export async function createProposal(opts: {
  campId: string;
  crawlRunId: string;
  sourceUrl: string;
  rawExtraction: Record<string, unknown>;
  proposedChanges: ProposedChanges;
  overallConfidence: number;
  extractionModel: string;
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
       ("campId", "crawlRunId", "sourceUrl", "rawExtraction", "proposedChanges", "overallConfidence", "extractionModel")
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [opts.campId, opts.crawlRunId, opts.sourceUrl,
     JSON.stringify(opts.rawExtraction), JSON.stringify(opts.proposedChanges),
     opts.overallConfidence, opts.extractionModel]
  );
  return result.rows[0].id;
}

export async function getPendingProposals(opts: {
  limit?: number;
  offset?: number;
  minConfidence?: number;
  campId?: string;
  providerId?: string;
  communitySlugs?: string[];
}): Promise<{ proposals: CampChangeProposal[]; total: number }> {
  const pool = getPool();
  const { limit = 20, offset = 0, minConfidence = 0, campId, providerId, communitySlugs } = opts;
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

  const whereClause = filters.join(' AND ');
  const rowValues = [...filterValues, limit, offset];

  const [rows, countRow] = await Promise.all([
    pool.query(
      `SELECT p.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug",
              c."providerId", c."lastVerifiedAt",
              r."startedAt" AS "crawlStartedAt", r."completedAt" AS "crawlCompletedAt", r.trigger AS "crawlTrigger"
       FROM "CampChangeProposal" p
       JOIN "Camp" c ON c.id = p."campId"
       LEFT JOIN "CrawlRun" r ON r.id = p."crawlRunId"
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScope.clause}
       ORDER BY p.priority DESC, p."createdAt" DESC
       LIMIT $${filterValues.length + 1} OFFSET $${filterValues.length + 2}`,
      rowValues
    ),
    pool.query(
      `SELECT COUNT(*)
       FROM "CampChangeProposal" p
       JOIN "Camp" c ON c.id = p."campId"
       WHERE ${whereClause} AND c."archivedAt" IS NULL${communityScope.clause}`,
      filterValues
    ),
  ]);

  return {
    proposals: rows.rows,
    total: parseInt(countRow.rows[0].count),
  };
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
  return proposal;
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
  feedbackTags?: string[]
): Promise<void> {
  const pool = getPool();
  await pool.query(
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
): Promise<void> {
  const pool = getPool();
  // Merge new applied fields with any previously applied ones (deduplicate)
  await pool.query(
    `UPDATE "CampChangeProposal"
     SET "appliedFields" = (
           SELECT array_agg(DISTINCT f ORDER BY f)
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
