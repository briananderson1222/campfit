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
      `SELECT p.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug"
       FROM "CampChangeProposal" p
       JOIN "Camp" c ON c.id = p."campId"
       WHERE p.status = 'PENDING' AND p."overallConfidence" >= $1
       ORDER BY p."createdAt" DESC
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
    `SELECT p.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug"
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
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

export async function getPendingCount(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(`SELECT COUNT(*) FROM "CampChangeProposal" WHERE status = 'PENDING'`);
  return parseInt(result.rows[0].count);
}
