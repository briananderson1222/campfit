import { getPool } from '@/lib/db';
import Link from 'next/link';
import { requireAdminAccess } from '@/lib/admin/access';
import { CampsTable } from './camps-table';

export const dynamic = 'force-dynamic';

interface CampRow {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  dataConfidence: string;
  lastVerifiedAt: string | null;
  communitySlug: string;
  registrationStatus: string;
  scheduleCount: number;
  missingFieldCount: number;
  pendingProposals: number;
}

async function getCampsWithQuality(
  archived: 'active' | 'archived' = 'active',
  communitySlugs?: string[],
): Promise<CampRow[]> {
  const pool = getPool();
  const values: unknown[] = [];
  const communityClause = communitySlugs && communitySlugs.length > 0
    ? `AND c."communitySlug" = ANY($1::text[])`
    : '';
  if (communityClause) values.push(communitySlugs);
  const result = await pool.query<CampRow>(`
    SELECT
      c.id,
      c.name,
      c.slug,
      c."websiteUrl",
      c."dataConfidence",
      c."lastVerifiedAt",
      c."communitySlug",
      c."registrationStatus",
      (SELECT COUNT(*)::int FROM "CampSchedule" s WHERE s."campId" = c.id) AS "scheduleCount",
      (CASE WHEN c.description = '' OR c.description IS NULL THEN 1 ELSE 0 END +
       CASE WHEN c."websiteUrl" = '' OR c."websiteUrl" IS NULL THEN 1 ELSE 0 END +
       CASE WHEN c.neighborhood = '' OR c.neighborhood IS NULL THEN 1 ELSE 0 END +
       CASE WHEN c."registrationStatus" = 'UNKNOWN' THEN 1 ELSE 0 END) AS "missingFieldCount",
      (SELECT COUNT(*)::int FROM "CampChangeProposal"
       WHERE "campId" = c.id AND status = 'PENDING') AS "pendingProposals"
    FROM "Camp" c
    WHERE c."archivedAt" IS ${archived === 'archived' ? 'NOT NULL' : 'NULL'}
      ${communityClause}
    ORDER BY "missingFieldCount" DESC, "lastVerifiedAt" ASC NULLS FIRST
  `, values);
  return result.rows;
}

export default async function AdminCampsPage(
  props: {
    searchParams: Promise<{ archived?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;
  const archived = searchParams.archived === '1' ? 'archived' : 'active';
  const camps = await getCampsWithQuality(
    archived,
    auth.access.isAdmin ? undefined : auth.access.communities,
  ).catch(() => [] as CampRow[]);

  return (
    <div>
      <div className="mb-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-extrabold text-bark-700">Camp Data</h1>
            <p className="text-bark-400 text-sm mt-1">
              {camps.length} camps · sorted by missing fields then oldest verified · click Crawl to refresh a camp
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href={archived === 'archived' ? '/admin/camps' : '/admin/camps?archived=1'} className="btn-secondary text-sm">
              {archived === 'archived' ? 'View Active' : 'View Archived'}
            </Link>
            {/* Reaching this page already required admin or moderator-of-some-
                community access (see `requireAdminAccess` above); `/admin/camps/new`
                now scopes its own provider dropdown to the caller's communities
                (or all of them for admins) instead of hardcoding a single
                community, so it's safe to show this link regardless of how
                many communities the caller moderates. */}
            <Link
              href="/admin/camps/new"
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-pine-600 hover:bg-pine-700 text-cream-100 text-sm font-semibold rounded-xl transition-colors"
            >
              <span className="text-lg leading-none">+</span>
              New Camp
            </Link>
          </div>
        </div>
      </div>

      <CampsTable camps={camps} archived={archived} />
    </div>
  );
}
