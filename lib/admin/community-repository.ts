import { getPool } from '@/lib/db';

export async function getNeighborhoodNames(communitySlug: string): Promise<string[]> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1 ORDER BY name ASC`,
    [communitySlug]
  );
  return rows.map(r => r.name);
}

export async function createNeighborhood(communitySlug: string, name: string): Promise<void> {
  await getPool().query(
    `INSERT INTO "CommunityNeighborhood"("communitySlug", name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [communitySlug, name]
  );
}

export async function getCommunitySummaries(scope: { isAdmin: boolean; communities: string[] }) {
  const values: unknown[] = [];
  const scopedClause = scope.isAdmin
    ? ''
    : `WHERE "communitySlug" = ANY($1::text[])`;
  if (!scope.isAdmin) values.push(scope.communities);

  const { rows } = await getPool().query(
    `SELECT "communitySlug", MAX("displayName") AS "displayName", COUNT(*)::int AS count
     FROM "Camp"
     ${scopedClause}
     GROUP BY "communitySlug"
     ORDER BY "communitySlug" ASC`,
    values,
  );
  return rows;
}
