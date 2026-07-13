import { getPool } from '@/lib/db';

export async function getSiteHints(domain: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM "CrawlSiteHint" WHERE domain = $1 ORDER BY "createdAt" ASC`,
    [domain]
  );
  return rows;
}

export async function getAdminCampSiteHints(domain: string) {
  if (!domain) return [];
  return getSiteHints(domain);
}

export async function getProviderEditorSiteHints(domain: string | null): Promise<Array<{
  id: string;
  hint: string;
  active: boolean;
  createdAt: string;
}>> {
  const { rows } = await getPool().query<{
    id: string;
    hint: string;
    active: boolean;
    createdAt: string;
  }>(
    `SELECT id, hint, active, "createdAt" FROM "CrawlSiteHint" WHERE domain = $1 ORDER BY "createdAt" ASC`,
    [domain],
  );
  return rows;
}

export async function createSiteHint(input: {
  domain: string;
  hint: string;
  source: string;
  sourceId: unknown;
  createdBy: string;
}) {
  const { rows } = await getPool().query(
    `INSERT INTO "CrawlSiteHint" (domain, hint, source, "sourceId", "createdBy")
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.domain, input.hint, input.source, input.sourceId, input.createdBy]
  );
  return rows[0];
}

export async function updateSiteHint(hintId: string, body: { active?: boolean; hint?: string }) {
  const sets: string[] = ['"updatedAt" = now()'];
  const vals: unknown[] = [hintId];
  if (body.active !== undefined) { sets.push(`active = $${vals.length + 1}`); vals.push(body.active); }
  if (body.hint !== undefined) { sets.push(`hint = $${vals.length + 1}`); vals.push(body.hint.trim()); }

  const { rows } = await getPool().query(
    `UPDATE "CrawlSiteHint" SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    vals
  );
  return rows[0];
}

export async function deleteSiteHint(hintId: string): Promise<void> {
  await getPool().query(`DELETE FROM "CrawlSiteHint" WHERE id = $1`, [hintId]);
}
