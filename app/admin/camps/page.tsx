import { getPool } from '@/lib/db';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { ExternalLink } from 'lucide-react';
import { RecrawlButton } from './recrawl-button';

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

async function getCampsWithQuality(): Promise<CampRow[]> {
  const pool = getPool();
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
    ORDER BY "missingFieldCount" DESC, "lastVerifiedAt" ASC NULLS FIRST
  `);
  return result.rows;
}

export default async function AdminCampsPage() {
  const camps = await getCampsWithQuality().catch(() => [] as CampRow[]);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-extrabold text-bark-700">Camp Data</h1>
        <p className="text-bark-400 text-sm mt-1">
          {camps.length} camps · sorted by missing fields then oldest verified · click Crawl to refresh a camp
        </p>
      </div>

      {/* Mobile: card list */}
      <div className="sm:hidden space-y-2">
        {camps.length === 0 ? (
          <p className="text-bark-300 text-sm text-center py-8">No camps found</p>
        ) : camps.map(camp => (
          <div key={camp.id} className="glass-panel p-4">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <Link
                  href={`/c/${camp.communitySlug}/camps/${camp.slug}`}
                  target="_blank"
                  className="font-medium text-bark-700 hover:text-pine-600 transition-colors text-sm leading-snug"
                >
                  {camp.name}
                </Link>
                <p className="text-xs text-bark-300 mt-0.5">{camp.communitySlug}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {camp.websiteUrl && (
                  <a href={camp.websiteUrl} target="_blank" rel="noopener noreferrer"
                    className="text-bark-300 hover:text-pine-500 transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <StatusBadge value={camp.registrationStatus} />
              <ConfidenceBadge value={camp.dataConfidence} />
              {camp.pendingProposals > 0 && (
                <Link
                  href={`/admin/review?campId=${camp.id}`}
                  className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold hover:bg-amber-200 transition-colors"
                >
                  {camp.pendingProposals} pending
                </Link>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-bark-400">
                <span>
                  {camp.lastVerifiedAt
                    ? new Date(camp.lastVerifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                    : <span className="text-red-400 font-medium">Never verified</span>}
                </span>
                <span>{camp.scheduleCount > 0 ? `${camp.scheduleCount} wks` : <span className="text-red-400">0 wks</span>}</span>
                {camp.missingFieldCount > 0 && (
                  <span className={cn(
                    'font-medium',
                    camp.missingFieldCount <= 2 ? 'text-amber-600' : 'text-red-500'
                  )}>
                    {camp.missingFieldCount} missing
                  </span>
                )}
              </div>
              <RecrawlButton campId={camp.id} campName={camp.name} />
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: table */}
      <div className="hidden sm:block glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-300/60 text-xs text-bark-300 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-semibold">Camp</th>
              <th className="text-left px-4 py-3 font-semibold">Status</th>
              <th className="text-left px-4 py-3 font-semibold">Confidence</th>
              <th className="text-left px-4 py-3 font-semibold">Last Verified</th>
              <th className="text-center px-4 py-3 font-semibold">Weeks</th>
              <th className="text-center px-4 py-3 font-semibold">Missing</th>
              <th className="text-center px-4 py-3 font-semibold">Pending</th>
              <th className="px-4 py-3 font-semibold text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {camps.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-bark-300">No camps found</td>
              </tr>
            ) : (
              camps.map((camp, i) => (
                <tr
                  key={camp.id}
                  className={cn(
                    'border-b border-cream-200/50 hover:bg-cream-100/60 transition-colors',
                    i % 2 === 0 ? 'bg-white/20' : 'bg-cream-50/30'
                  )}
                >
                  <td className="px-4 py-3">
                    <Link href={`/c/${camp.communitySlug}/camps/${camp.slug}`} target="_blank"
                      className="font-medium text-bark-700 hover:text-pine-600 transition-colors">
                      {camp.name}
                    </Link>
                    <p className="text-xs text-bark-300 mt-0.5">{camp.communitySlug}</p>
                  </td>
                  <td className="px-4 py-3"><StatusBadge value={camp.registrationStatus} /></td>
                  <td className="px-4 py-3"><ConfidenceBadge value={camp.dataConfidence} /></td>
                  <td className="px-4 py-3 text-bark-400 text-xs">
                    {camp.lastVerifiedAt
                      ? new Date(camp.lastVerifiedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                      : <span className="text-red-400 font-medium">Never</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-bark-400">
                    {camp.scheduleCount > 0 ? camp.scheduleCount : <span className="text-red-400">0</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn(
                      'inline-flex w-7 h-7 rounded-full text-xs font-bold items-center justify-center',
                      camp.missingFieldCount === 0 ? 'bg-pine-100 text-pine-600'
                        : camp.missingFieldCount <= 2 ? 'bg-amber-100 text-amber-700'
                        : 'bg-red-100 text-red-600'
                    )}>
                      {camp.missingFieldCount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {camp.pendingProposals > 0 ? (
                      <Link href={`/admin/review?campId=${camp.id}`}
                        className="inline-block px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-bold hover:bg-amber-200 transition-colors">
                        {camp.pendingProposals}
                      </Link>
                    ) : (
                      <span className="text-bark-200 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <RecrawlButton campId={camp.id} campName={camp.name} />
                      {camp.websiteUrl && (
                        <a href={camp.websiteUrl} target="_blank" rel="noopener noreferrer"
                          className="text-bark-300 hover:text-pine-500 transition-colors" title={camp.websiteUrl}>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const colors: Record<string, string> = {
    OPEN: 'bg-emerald-100 text-emerald-700',
    CLOSED: 'bg-red-100 text-red-600',
    COMING_SOON: 'bg-amber-100 text-amber-700',
    UNKNOWN: 'bg-gray-100 text-gray-500',
  };
  const labels: Record<string, string> = {
    OPEN: 'Open', CLOSED: 'Closed', COMING_SOON: 'Soon', UNKNOWN: '?',
  };
  return (
    <span className={cn(
      'inline-block px-2 py-0.5 rounded-full text-xs font-semibold',
      colors[value] ?? 'bg-cream-200 text-bark-400'
    )}>
      {labels[value] ?? value}
    </span>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const colors: Record<string, string> = {
    VERIFIED: 'bg-pine-100 text-pine-700',
    STALE: 'bg-amber-100 text-amber-700',
    PLACEHOLDER: 'bg-red-100 text-red-600',
  };
  return (
    <span className={cn(
      'inline-block px-2 py-0.5 rounded-full text-xs font-semibold',
      colors[value] ?? 'bg-cream-200 text-bark-400'
    )}>
      {value}
    </span>
  );
}
