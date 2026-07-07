import { getPool } from '@/lib/db';
import type { AdminEntityType } from './entity-admin-repository';

export async function getCampCommunitySlug(campId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT "communitySlug" FROM "Camp" WHERE id = $1`,
    [campId],
  );
  return rows[0]?.communitySlug ?? null;
}

export async function getProviderCommunitySlug(providerId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT "communitySlug" FROM "Provider" WHERE id = $1`,
    [providerId],
  );
  return rows[0]?.communitySlug ?? null;
}

export async function getProposalCommunitySlug(proposalId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT c."communitySlug"
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
     WHERE p.id = $1`,
    [proposalId],
  );
  return rows[0]?.communitySlug ?? null;
}

/**
 * Bulk variant of `getProposalCommunitySlug` (review L5, campfit#51) — ONE
 * `ANY($1::text[])` query for every distinct proposalId, instead of one
 * query per proposalId in a loop. Mirrors this same batch-accept route's
 * OWN pre-existing `campIdsForProposals` bulk-lookup pattern
 * (`app/api/admin/review/batch-accept/route.ts`), applied to the
 * per-selection community-scope re-check specifically (the #93-lesson gate
 * that used to run once per distinct proposalId). A proposalId absent from
 * the result map (nonexistent id, or a Camp row with no `communitySlug`)
 * is simply missing from the map — callers treat that the same as `null`
 * (excluded), identical to `getProposalCommunitySlug`'s own not-found
 * behavior.
 */
export async function getProposalCommunitySlugs(proposalIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (proposalIds.length === 0) return map;
  const { rows } = await getPool().query<{ id: string; communitySlug: string | null }>(
    `SELECT p.id, c."communitySlug"
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
     WHERE p.id = ANY($1::text[])`,
    [proposalIds],
  );
  for (const row of rows) map.set(row.id, row.communitySlug);
  return map;
}

export async function getProposalCommunityScope(proposalId: string): Promise<{ communitySlug: string | null } | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT c."communitySlug"
     FROM "CampChangeProposal" p
     JOIN "Camp" c ON c.id = p."campId"
     WHERE p.id = $1`,
    [proposalId],
  );
  return rows[0] ?? null;
}

export async function getProviderProposalCommunitySlug(proposalId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT p."communitySlug"
     FROM "ProviderChangeProposal" proposal
     JOIN "Provider" p ON p.id = proposal."providerId"
     WHERE proposal.id = $1`,
    [proposalId],
  );
  return rows[0]?.communitySlug ?? null;
}

export async function getReportCommunitySlug(reportId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT c."communitySlug"
     FROM "CampReport" r
     JOIN "Camp" c ON c.id = r."campId"
     WHERE r.id = $1`,
    [reportId],
  );
  return rows[0]?.communitySlug ?? null;
}

export async function getEntityCommunitySlug(entityType: AdminEntityType, entityId: string): Promise<string | null> {
  if (entityType === 'CAMP') return getCampCommunitySlug(entityId);
  if (entityType === 'PROVIDER') return getProviderCommunitySlug(entityId);
  return null;
}

export async function getFlagCommunity(flagId: string): Promise<{ entityType: AdminEntityType; entityId: string; communitySlug: string | null } | null> {
  const { rows } = await getPool().query<{ entityType: AdminEntityType; entityId: string }>(
    `SELECT "entityType", "entityId" FROM "ReviewFlag" WHERE id = $1`,
    [flagId],
  );
  const flag = rows[0];
  if (!flag) return null;
  return {
    entityType: flag.entityType,
    entityId: flag.entityId,
    communitySlug: await getEntityCommunitySlug(flag.entityType, flag.entityId),
  };
}

export async function getCampIdsCommunitySlugs(campIds: string[]): Promise<string[]> {
  if (campIds.length === 0) return [];
  const { rows } = await getPool().query<{ communitySlug: string }>(
    `SELECT DISTINCT "communitySlug"
     FROM "Camp"
     WHERE id = ANY($1::text[])`,
    [campIds],
  );
  return rows.map((row) => row.communitySlug);
}

export function communityScopeSql(
  communitySlugs: string[] | undefined,
  columnSql: string,
  firstParamIndex = 1,
): { clause: string; values: unknown[] } {
  if (!communitySlugs || communitySlugs.length === 0) return { clause: '', values: [] };
  return {
    clause: ` AND ${columnSql} = ANY($${firstParamIndex}::text[])`,
    values: [communitySlugs],
  };
}

/**
 * campfit#93 (Wave 3/4): community scope for an `AggregatorSource` row, the
 * same pre-auth "look up the community this id belongs to" pattern every
 * other `get*CommunitySlug` helper in this file establishes — so a caller
 * never leaks whether an id exists to an unauthorized requester (auth runs
 * against the resolved slug BEFORE the route re-fetches the full row for a
 * 404 check). Assumes `ensureAggregatorSourceSchema()` has already run in
 * the same request (every aggregator route calls it idempotently first).
 */
export async function getAggregatorSourceCommunitySlug(aggregatorSourceId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ communitySlug: string | null }>(
    `SELECT "communitySlug" FROM "AggregatorSource" WHERE id = $1`,
    [aggregatorSourceId],
  );
  return rows[0]?.communitySlug ?? null;
}
