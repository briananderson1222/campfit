import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getPool } from '@/lib/db';

export async function GET() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const values: unknown[] = [];
  const scopedClause = auth.access.isAdmin
    ? ''
    : `WHERE "communitySlug" = ANY($1::text[])`;
  if (!auth.access.isAdmin) values.push(auth.access.communities);

  const { rows } = await getPool().query(
    `SELECT "communitySlug", MAX("displayName") AS "displayName", COUNT(*)::int AS count
     FROM "Camp"
     ${scopedClause}
     GROUP BY "communitySlug"
     ORDER BY "communitySlug" ASC`,
    values,
  );
  return NextResponse.json({ communities: rows });
}
