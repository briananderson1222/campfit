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
