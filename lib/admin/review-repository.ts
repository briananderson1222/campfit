import { getPool } from '@/lib/db';
import type { CampChangeProposal, ProposedChanges, ProposalStatus } from './types';

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
}): Promise<{ proposals: CampChangeProposal[]; total: number }> {
  const pool = getPool();
  const { limit = 20, offset = 0, minConfidence = 0 } = opts;

  const [rows, countRow] = await Promise.all([
    pool.query(
      `SELECT p.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug",
              r."startedAt" AS "crawlStartedAt", r.trigger AS "crawlTrigger"
       FROM "CampChangeProposal" p
       JOIN "Camp" c ON c.id = p."campId"
       LEFT JOIN "CrawlRun" r ON r.id = p."crawlRunId"
       WHERE p.status = 'PENDING' AND p."overallConfidence" >= $1
       ORDER BY p.priority DESC, p."createdAt" DESC
       LIMIT $2 OFFSET $3`,
      [minConfidence, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) FROM "CampChangeProposal" WHERE status = 'PENDING' AND "overallConfidence" >= $1`,
      [minConfidence]
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
            r."startedAt" AS "crawlStartedAt", r.trigger AS "crawlTrigger", r."triggeredBy" AS "crawlTriggeredBy",
            row_to_json(c.*) AS "campData"
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
     LEFT JOIN "CrawlRun" r ON r.id = p."crawlRunId"
     WHERE p.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
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
}): Promise<{ camps: UnverifiedCamp[]; total: number }> {
  const pool = getPool();
  const { limit = 50, offset = 0 } = opts;

  const base = `FROM "Camp" c
    WHERE c."dataConfidence" != 'VERIFIED'
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
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(`SELECT COUNT(*) ${base}`),
  ]);

  return { camps: rows.rows, total: parseInt(countRow.rows[0].count) };
}

export async function getPendingCount(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(`SELECT COUNT(*) FROM "CampChangeProposal" WHERE status = 'PENDING'`);
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
}): Promise<{ reports: CampReport[]; total: number }> {
  const pool = getPool();
  const { limit = 25, offset = 0 } = opts;

  const [rows, countRow] = await Promise.all([
    pool.query(
      `SELECT r.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug"
       FROM "CampReport" r
       JOIN "Camp" c ON c.id = r."campId"
       WHERE r.status = 'PENDING'
       ORDER BY r."createdAt" DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(`SELECT COUNT(*) FROM "CampReport" WHERE status = 'PENDING'`),
  ]);

  return { reports: rows.rows, total: parseInt(countRow.rows[0].count) };
}
