import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampIdsCommunitySlugs } from '@/lib/admin/community-access';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM "CrawlRun" ORDER BY "startedAt" DESC LIMIT 50`
  );
  const rawRuns = result.rows;
  const runs = auth.access.isAdmin
    ? rawRuns
    : (await Promise.all(rawRuns.map(async (run: { campIds: string[] | null }) => {
        const communities = await getCampIdsCommunitySlugs(run.campIds ?? []);
        return communities.length > 0 && communities.every((community) => auth.access.communities.includes(community))
          ? run
          : null;
      }))).filter(Boolean);

  // Resolve campIds → camp names for targeted runs
  const allCampIds = Array.from(new Set(runs.flatMap((r: { campIds: string[] | null }) => r.campIds ?? [])));
  const campNames: Record<string, string> = {};
  if (allCampIds.length > 0) {
    const camps = await pool.query(
      `SELECT id, name FROM "Camp" WHERE id = ANY($1)`, [allCampIds]
    );
    camps.rows.forEach((c: { id: string; name: string }) => { campNames[c.id] = c.name; });
  }

  return NextResponse.json({ runs, campNames });
}
