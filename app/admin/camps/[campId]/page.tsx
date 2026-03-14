import { getPool } from '@/lib/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, ArrowLeft } from 'lucide-react';
import { CampEditor } from './camp-editor';
import { EntityOpsPanel } from '@/components/admin/entity-ops-panel';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';

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
  const c = campRes.rows[0];
  // pg returns `date` columns as Date objects — normalize to YYYY-MM-DD string
  // so it passes cleanly through EditableField's string display logic.
  if (c.registrationOpenDate instanceof Date) {
    c.registrationOpenDate = c.registrationOpenDate.toISOString().split('T')[0];
  }
  if (c.registrationCloseDate instanceof Date) {
    c.registrationCloseDate = c.registrationCloseDate.toISOString().split('T')[0];
  }
  if (!Array.isArray(c.campTypes)) c.campTypes = c.campType ? [c.campType] : [];
  if (!Array.isArray(c.categories)) c.categories = c.category ? [c.category] : [];
  return { ...c, ageGroups: ageRes.rows, schedules: schedRes.rows, pricing: priceRes.rows };
}

async function getPendingProposals(campId: string) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, "createdAt", "overallConfidence", "appliedFields",
            (SELECT count(*)::int FROM jsonb_object_keys("proposedChanges")) AS "fieldCount"
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
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) notFound();
  const camp = await getCamp(params.campId).catch(() => null);
  if (!camp) notFound();

  const domain = domainOf(camp.websiteUrl);
  const [pendingProposals, siteHints] = await Promise.all([
    getPendingProposals(params.campId).catch(err => { console.error('[admin/camps] getPendingProposals failed:', err); return []; }),
    getSiteHints(domain).catch(err => { console.error('[admin/camps] getSiteHints failed:', err); return []; }),
  ]);
  const attestationTargets = [
    { value: 'name', label: 'Name' },
    { value: 'organizationName', label: 'Organization' },
    { value: 'description', label: 'Description' },
    { value: 'websiteUrl', label: 'Website URL' },
    { value: 'applicationUrl', label: 'Application URL' },
    { value: 'contactEmail', label: 'Contact Email' },
    { value: 'contactPhone', label: 'Contact Phone' },
    { value: 'socialLinks', label: 'Social Links' },
    { value: 'interestingDetails', label: 'Interesting Details' },
    { value: 'city', label: 'City' },
    { value: 'state', label: 'State' },
    { value: 'zip', label: 'ZIP' },
    { value: 'neighborhood', label: 'Neighborhood' },
    { value: 'address', label: 'Address' },
    { value: 'lunchIncluded', label: 'Lunch Included' },
    { value: 'registrationStatus', label: 'Registration Status' },
    { value: 'registrationOpenDate', label: 'Registration Open Date' },
    { value: 'registrationCloseDate', label: 'Registration Close Date' },
    { value: 'campTypes', label: 'Camp Types' },
    { value: 'categories', label: 'Categories' },
    ...camp.ageGroups.map((group: { id: string; label: string; minAge: number | null; maxAge: number | null }) => ({
      value: `ageGroups:${group.id}`,
      label: `Age Group: ${group.label || [group.minAge, group.maxAge].filter((value) => value != null).join('-')}`,
    })),
    ...camp.schedules.map((schedule: { id: string; label: string; startDate: string; endDate: string }) => ({
      value: `schedules:${schedule.id}`,
      label: `Schedule: ${schedule.label || `${schedule.startDate} to ${schedule.endDate}`}`,
    })),
    ...camp.pricing.map((pricing: { id: string; label: string; amount: number; unit: string }) => ({
      value: `pricing:${pricing.id}`,
      label: `Pricing: ${pricing.label || `${pricing.amount} ${pricing.unit}`}`,
    })),
    { value: 'provider', label: 'Provider Link' },
  ];

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
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <p className="text-xs text-bark-300">{camp.communitySlug} · {camp.id}</p>
            {camp.archivedAt && (
              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                Archived
              </span>
            )}
          </div>
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

      <EntityOpsPanel entityType="CAMP" entityId={camp.id} allowAccreditation attestationTargets={attestationTargets} />
    </div>
  );
}
