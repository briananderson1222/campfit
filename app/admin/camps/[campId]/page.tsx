import { getPool } from '@/lib/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, ArrowLeft } from 'lucide-react';
import { CampEditor } from './camp-editor';

export const dynamic = 'force-dynamic';

async function getCamp(campId: string) {
  const pool = getPool();
  const [campRes, ageRes, schedRes, priceRes] = await Promise.all([
    pool.query(`SELECT * FROM "Camp" WHERE id = $1`, [campId]),
    pool.query(`SELECT * FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge" ASC NULLS LAST`, [campId]),
    pool.query(`SELECT * FROM "CampSchedule" WHERE "campId" = $1 ORDER BY "startDate" ASC`, [campId]),
    pool.query(`SELECT * FROM "CampPricing" WHERE "campId" = $1 ORDER BY amount ASC`, [campId]),
  ]);
  if (!campRes.rows[0]) return null;
  return { ...campRes.rows[0], ageGroups: ageRes.rows, schedules: schedRes.rows, pricing: priceRes.rows };
}

async function getPendingProposals(campId: string) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, "createdAt", "overallConfidence", "appliedFields",
            array_length(array(SELECT jsonb_object_keys("proposedChanges")), 1) AS "fieldCount"
     FROM "CampChangeProposal"
     WHERE "campId" = $1 AND status = 'PENDING'
     ORDER BY priority DESC, "createdAt" DESC`,
    [campId]
  );
  return rows;
}

async function getSiteHints(domain: string) {
  if (!domain) return [];
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM "CrawlSiteHint" WHERE domain = $1 ORDER BY "createdAt" ASC`,
    [domain]
  );
  return rows;
}

function domainOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export default async function AdminCampDetailPage({ params }: { params: { campId: string } }) {
  const camp = await getCamp(params.campId).catch(() => null);
  if (!camp) notFound();

  const domain = domainOf(camp.websiteUrl);
  const [pendingProposals, siteHints] = await Promise.all([
    getPendingProposals(params.campId),
    getSiteHints(domain),
  ]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/camps" className="text-bark-300 hover:text-bark-500 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-2xl font-extrabold text-bark-700 dark:text-cream-100 truncate">{camp.name}</h1>
          {camp.organizationName && (
            <p className="text-sm text-bark-400 dark:text-bark-300 mt-0.5">{camp.organizationName}</p>
          )}
          <p className="text-xs text-bark-300 mt-0.5">{camp.communitySlug} · {camp.id}</p>
        </div>
        <Link
          href={`/c/${camp.communitySlug}/camps/${camp.slug}`}
          target="_blank"
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-cream-300 text-bark-400 hover:text-pine-600 hover:border-pine-300 transition-colors shrink-0"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Public page
        </Link>
      </div>

      <CampEditor
        camp={camp}
        pendingProposals={pendingProposals}
        siteHints={siteHints}
        domain={domain}
      />
    </div>
  );
}
