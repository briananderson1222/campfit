import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, ArrowLeft } from 'lucide-react';
import { CampEditor } from './camp-editor';
import { EntityOpsPanel } from '@/components/admin/entity-ops-panel';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { getCampFieldTimeline } from '@/lib/admin/field-metadata';
import { coverageFromRollup, deriveCampVerification } from '@/lib/admin/verification-authority';
import { getAdminCampDetail, getAdminCampPendingProposals } from '@/lib/admin/camp-repository';
import { getAdminCampSiteHints } from '@/lib/admin/site-hint-repository';

export const dynamic = 'force-dynamic';

function domainOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export default async function AdminCampDetailPage(props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) notFound();
  const camp = await getAdminCampDetail(params.campId).catch(() => null);
  if (!camp) notFound();

  const domain = domainOf(camp.websiteUrl);
  const [pendingProposals, siteHints, coverage] = await Promise.all([
    getAdminCampPendingProposals(params.campId).catch(err => { console.error('[admin/camps] getPendingProposals failed:', err); return []; }),
    getAdminCampSiteHints(domain).catch(err => { console.error('[admin/camps] getSiteHints failed:', err); return []; }),
    deriveCampVerification(params.campId)
      .then(rollup => coverageFromRollup(rollup, camp))
      .catch(err => { console.error('[admin/camps] deriveCampVerification failed:', err); return null; }),
  ]);
  const fieldTimeline = await getCampFieldTimeline(params.campId).catch((err) => {
    console.error('[admin/camps] getCampFieldTimeline failed:', err);
    return {};
  });

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
        camp={{ ...camp, fieldTimeline }}
        pendingProposals={pendingProposals}
        siteHints={siteHints}
        domain={domain}
        coverage={coverage}
      />

      <EntityOpsPanel entityType="CAMP" entityId={camp.id} allowAccreditation />
    </div>
  );
}
