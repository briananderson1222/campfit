import type { Pool, PoolClient } from 'pg';
import { getPool } from '@/lib/db';
import type { Provider, ProviderWithStats } from '@/lib/types';
import { communityScopeSql } from './community-access';
import type { ProviderChangeProposal } from './types';
import { parseDomain } from './onboarding-validation';

function db() {
  return getPool();
}

/**
 * Either a bare `Pool` or an already-checked-out `PoolClient` — both expose
 * `.query()`. Lets `findProviderByDomain`/`createProvider` join an existing
 * transaction (e.g. `onboardProviderCandidate`'s candidate-row lock) instead
 * of always issuing their own implicit-transaction statement against the
 * shared pool singleton. Additive: every existing call site (this file's own
 * exports, `POST /api/admin/providers`) keeps working unchanged because the
 * parameter defaults to `getPool()`. Mirrors `lib/admin/claim-store.ts`'s own
 * `Queryable` precedent.
 */
type Queryable = Pool | PoolClient;

/** All providers with rollup stats, ordered by name. */
export async function getProviders(
  communitySlug: string | string[] = 'denver',
  archived: 'active' | 'archived' | 'all' = 'active',
): Promise<ProviderWithStats[]> {
  const archivedClause = archived === 'archived'
    ? `AND p."archivedAt" IS NOT NULL`
    : archived === 'all'
      ? ''
      : `AND p."archivedAt" IS NULL`;
  const communitySlugs = Array.isArray(communitySlug) ? communitySlug : [communitySlug];
  const communityScope = communityScopeSql(communitySlugs, `p."communitySlug"`, 1);
  const { rows } = await db().query<ProviderWithStats>(`
    SELECT
      p.*,
      COUNT(DISTINCT c.id)::int                                          AS "campCount",
      COUNT(DISTINCT cp.id) FILTER (WHERE cp.status = 'PENDING')::int   AS "pendingProposals",
      MAX(cr."completedAt")                                              AS "lastCrawledAt",
      ROUND(AVG(cp2."overallConfidence")::numeric, 2)::float            AS "avgConfidence"
    FROM "Provider" p
    LEFT JOIN "Camp" c ON c."providerId" = p.id
    LEFT JOIN "CampChangeProposal" cp ON cp."campId" = c.id
    LEFT JOIN "CrawlRun" cr ON cr.id = (
      SELECT cl."crawlRunId"
      FROM "CampChangeProposal" cl
      WHERE cl."campId" = c.id
      ORDER BY cl."createdAt" DESC
      LIMIT 1
    )
    LEFT JOIN "CampChangeProposal" cp2 ON cp2."campId" = c.id
    WHERE 1 = 1
      ${communityScope.clause}
      ${archivedClause}
    GROUP BY p.id
    ORDER BY p.name ASC
  `, communityScope.values);
  return rows;
}

/** Single provider with rollup stats. */
export async function getProvider(id: string): Promise<ProviderWithStats | null> {
  const { rows } = await db().query<ProviderWithStats>(`
    SELECT
      p.*,
      COUNT(DISTINCT c.id)::int                                          AS "campCount",
      COUNT(DISTINCT cp.id) FILTER (WHERE cp.status = 'PENDING')::int   AS "pendingProposals",
      MAX(cr."completedAt")                                              AS "lastCrawledAt",
      ROUND(AVG(cp2."overallConfidence")::numeric, 2)::float            AS "avgConfidence"
    FROM "Provider" p
    LEFT JOIN "Camp" c ON c."providerId" = p.id
    LEFT JOIN "CampChangeProposal" cp ON cp."campId" = c.id
    LEFT JOIN "CrawlRun" cr ON cr.id = (
      SELECT cl."crawlRunId"
      FROM "CampChangeProposal" cl
      WHERE cl."campId" = c.id
      ORDER BY cl."createdAt" DESC
      LIMIT 1
    )
    LEFT JOIN "CampChangeProposal" cp2 ON cp2."campId" = c.id
    WHERE p.id = $1
    GROUP BY p.id
  `, [id]);
  return rows[0] ?? null;
}

/** Camps belonging to a provider, with pending proposal count per camp. */
export async function getProviderCamps(
  providerId: string,
  archived: 'active' | 'archived' | 'all' = 'active',
) {
  const archivedClause = archived === 'archived'
    ? `AND c."archivedAt" IS NOT NULL`
    : archived === 'all'
      ? ''
      : `AND c."archivedAt" IS NULL`;
  const { rows } = await db().query(`
    SELECT
      c.id, c.name, c.slug, c.category, c."registrationStatus",
      c."dataConfidence", c."lastVerifiedAt", c."archivedAt",
      COUNT(cp.id) FILTER (WHERE cp.status = 'PENDING')::int AS "pendingCount"
    FROM "Camp" c
    LEFT JOIN "CampChangeProposal" cp ON cp."campId" = c.id
    WHERE c."providerId" = $1
      ${archivedClause}
    GROUP BY c.id
    ORDER BY c.name ASC
  `, [providerId]);
  return rows;
}

/** Pending proposals across all camps for a provider. */
export async function getProviderPendingProposals(providerId: string) {
  const { rows } = await db().query(`
    SELECT
      cp.id, cp."campId", cp."createdAt", cp."overallConfidence",
      cp."proposedChanges", cp."appliedFields",
      c.name AS "campName"
    FROM "CampChangeProposal" cp
    JOIN "Camp" c ON c.id = cp."campId"
    WHERE c."providerId" = $1 AND cp.status = 'PENDING' AND c."archivedAt" IS NULL
    ORDER BY cp.priority DESC, cp."createdAt" DESC
  `, [providerId]);
  return rows;
}

export async function getPendingProviderProposals(opts: {
  limit?: number;
  offset?: number;
  providerId?: string;
  communitySlugs?: string[];
}): Promise<{ proposals: ProviderChangeProposal[]; total: number }> {
  const { limit = 25, offset = 0, providerId, communitySlugs } = opts;
  const filters = [`pcp.status = 'PENDING'`, `p."archivedAt" IS NULL`];
  const values: unknown[] = [];
  const communityScope = communityScopeSql(communitySlugs, `p."communitySlug"`, values.length + 1);
  if (communityScope.values.length > 0) values.push(...communityScope.values);

  if (providerId) {
    values.push(providerId);
    filters.push(`pcp."providerId" = $${values.length}`);
  }

  const whereClause = `${filters.join(' AND ')}${communityScope.clause}`;
  const rowValues = [...values, limit, offset];
  const [rows, countRow] = await Promise.all([
    db().query<ProviderChangeProposal>(
      `SELECT pcp.*, p.name AS "providerName", p.slug AS "providerSlug", p."communitySlug"
       FROM "ProviderChangeProposal" pcp
       JOIN "Provider" p ON p.id = pcp."providerId"
       WHERE ${whereClause}
       ORDER BY pcp."createdAt" DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      rowValues,
    ),
    db().query(
      `SELECT COUNT(*)
       FROM "ProviderChangeProposal" pcp
       JOIN "Provider" p ON p.id = pcp."providerId"
       WHERE ${whereClause}`,
      values,
    ),
  ]);

  return {
    proposals: rows.rows,
    total: parseInt(countRow.rows[0].count, 10),
  };
}

export async function getProviderProposal(id: string): Promise<ProviderChangeProposal | null> {
  const { rows } = await db().query<ProviderChangeProposal>(
    `SELECT pcp.*, p.name AS "providerName", p.slug AS "providerSlug", p."communitySlug",
            row_to_json(p.*) AS "providerData"
     FROM "ProviderChangeProposal" pcp
     JOIN "Provider" p ON p.id = pcp."providerId"
     WHERE pcp.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

type ProviderProposalForApproval = {
  id: string;
  status: string;
  providerId: string;
  proposedChanges: Record<string, unknown> | null;
  communitySlug: string;
};

export async function getProviderProposalForApproval(id: string): Promise<ProviderProposalForApproval | null> {
  const { rows } = await db().query<ProviderProposalForApproval>(
    `SELECT pcp.*, p."communitySlug"
     FROM "ProviderChangeProposal" pcp
     JOIN "Provider" p ON p.id = pcp."providerId"
     WHERE pcp.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getProviderProposalForRejection(
  id: string,
): Promise<{ id: string; status: string; communitySlug: string } | null> {
  const { rows } = await db().query<{ id: string; status: string; communitySlug: string }>(
    `SELECT pcp.id, pcp.status, p."communitySlug"
     FROM "ProviderChangeProposal" pcp
     JOIN "Provider" p ON p.id = pcp."providerId"
     WHERE pcp.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getProviderRecordForProposal(providerId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db().query<Record<string, unknown>>(`SELECT * FROM "Provider" WHERE id = $1`, [providerId]);
  return rows[0];
}

export async function applyProviderProposalFields(
  providerId: string,
  entries: [string, unknown][],
): Promise<void> {
  const setClauses = entries.map(([key], index) => `"${key}" = $${index + 2}`).join(', ');
  await db().query(
    `UPDATE "Provider" SET ${setClauses}, "updatedAt" = now() WHERE id = $1`,
    [providerId, ...entries.map(([, value]) => {
      const diff = value as { new?: unknown };
      return diff?.new ?? value ?? null;
    })],
  );
}

export async function markProviderProposalApproved(
  id: string,
  reviewedBy: string,
  reviewerNotes: string | null,
): Promise<void> {
  await db().query(
    `UPDATE "ProviderChangeProposal"
     SET status = 'APPROVED', "reviewedAt" = now(), "reviewedBy" = $2, "reviewerNotes" = $3
     WHERE id = $1`,
    [id, reviewedBy, reviewerNotes],
  );
}

export async function markProviderProposalRejected(
  id: string,
  reviewedBy: string,
  reviewerNotes: string | null,
): Promise<number | null> {
  const { rowCount } = await db().query(
    `UPDATE "ProviderChangeProposal"
     SET status = 'REJECTED', "reviewedAt" = now(), "reviewedBy" = $2, "reviewerNotes" = $3
     WHERE id = $1 AND status = 'PENDING'`,
    [id, reviewedBy, reviewerNotes],
  );
  return rowCount;
}

export async function getPendingProviderProposalQueue(opts: {
  currentId: string;
  providerId?: string;
  communitySlugs?: string[];
}): Promise<{ previousId: string | null; nextId: string | null }> {
  const { proposals } = await getPendingProviderProposals({
    limit: 500,
    offset: 0,
    providerId: opts.providerId,
    communitySlugs: opts.communitySlugs,
  });
  const index = proposals.findIndex((proposal) => proposal.id === opts.currentId);
  if (index === -1) return { previousId: null, nextId: null };

  return {
    previousId: proposals[index - 1]?.id ?? null,
    nextId: proposals[index + 1]?.id ?? null,
  };
}

export async function getPendingProviderProposalCount(communitySlugs?: string[]): Promise<number> {
  const { total } = await getPendingProviderProposals({
    limit: 1,
    offset: 0,
    communitySlugs,
  });
  return total;
}

type CreateProviderInput = {
  name: string;
  websiteUrl?: string | null;
  address?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  crawlRootUrl?: string | null;
  communitySlug?: string;
  /** campfit#53 — see lib/types.ts's Provider.requiresRender doc. */
  requiresRender?: boolean;
};

/**
 * Finds a non-archived Provider whose normalized domain matches `domain`
 * (see `parseDomain`) — used by `POST /api/admin/providers` to block
 * duplicate-domain manual creates (campfit#90 R2/AC2), mirroring
 * `onboard-url/route.ts`'s existing `SELECT id, name FROM "Provider" WHERE
 * domain = $1` dedupe lookup. Deliberately global (no community scoping) —
 * a domain match must block creation regardless of which community the
 * existing provider lives in. `communitySlug` is returned so the route can
 * decide whether the requester is allowed to see *which* provider matched
 * (see the route's 409 handling) without ever changing whether the match
 * blocks the create.
 */
export async function findProviderByDomain(
  domain: string,
  executor: Queryable = getPool(),
): Promise<{ id: string; name: string; slug: string; communitySlug: string } | null> {
  const { rows } = await executor.query<{ id: string; name: string; slug: string; communitySlug: string }>(
    `SELECT id, name, slug, "communitySlug" FROM "Provider" WHERE domain = $1 AND "archivedAt" IS NULL LIMIT 1`,
    [domain],
  );
  return rows[0] ?? null;
}

/**
 * `executor` defaults to the shared pool singleton (zero behavior change for
 * existing callers, e.g. `POST /api/admin/providers`) but may be an
 * already-checked-out `PoolClient` so the insert joins a caller's own
 * transaction (see `onboardProviderCandidate`, campfit#93 H2).
 */
export async function createProvider(input: CreateProviderInput, executor: Queryable = getPool()): Promise<Provider> {
  const slug = await makeUniqueSlug(input.name, executor);
  const domain = parseDomain(input.websiteUrl);

  const { rows } = await executor.query<Provider>(`
    INSERT INTO "Provider"
      (name, slug, "websiteUrl", domain, address, city, neighborhood,
       "contactEmail", "contactPhone", notes, "crawlRootUrl", "communitySlug")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *
  `, [
    input.name, slug, input.websiteUrl ?? null, domain,
    input.address ?? null, input.city ?? null, input.neighborhood ?? null,
    input.contactEmail ?? null, input.contactPhone ?? null,
    input.notes ?? null, input.crawlRootUrl ?? null,
    input.communitySlug ?? 'denver',
  ]);
  return rows[0];
}

type UpdateProviderInput = Partial<Omit<CreateProviderInput, 'communitySlug'>>;

export async function updateProvider(id: string, input: UpdateProviderInput): Promise<Provider | null> {
  const allowed = ['name', 'websiteUrl', 'logoUrl', 'address', 'city', 'neighborhood',
                   'contactEmail', 'contactPhone', 'notes', 'crawlRootUrl', 'applicationUrl', 'socialLinks',
                   'requiresRender'] as const;
  const updates = Object.entries(input).filter(([k]) => (allowed as readonly string[]).includes(k));
  if (updates.length === 0) return null;

  // Recompute domain if websiteUrl is being updated
  const domainUpdate = 'websiteUrl' in input
    ? [['domain', parseDomain(input.websiteUrl)]]
    : [];

  const allUpdates = [...updates, ...domainUpdate];
  const setClauses = allUpdates.map(([k], i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [id, ...allUpdates.map(([, v]) => v ?? null)];

  const { rows } = await db().query<Provider>(
    `UPDATE "Provider" SET ${setClauses}, "updatedAt" = now() WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0] ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeUniqueSlug(name: string, executor: Queryable = getPool()): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await executor.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}
