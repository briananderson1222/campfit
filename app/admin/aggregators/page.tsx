/**
 * app/admin/aggregators/page.tsx — the first-ever admin UI for aggregator
 * registration (campfit#93 R1/AC1, Wave 3 Task 3.2).
 *
 * Follows `app/admin/providers/page.tsx`'s Server Component list idiom
 * (header, count, "+ New"-shaped affordance) exactly, including calling the
 * repository (`listAggregatorSources`) directly rather than round-tripping
 * through this app's own `GET /api/admin/aggregators` route — the same
 * choice `providers/page.tsx` makes for `getProviders`. That GET route
 * (Wave 3 Task 3.2, owned by a parallel worker) is still the contract the
 * client-side mutation flows (`register-form.tsx`, `tos-decision-form.tsx`,
 * `run-discovery-button.tsx`, `candidates-panel.tsx`) call into; only the
 * initial server-rendered read here bypasses it, matching existing
 * repo convention.
 *
 * Reconciliation note: `GET /api/admin/aggregators` (now landed by the
 * parallel API-route worker, `app/api/admin/aggregators/route.ts`) folds in
 * a `pendingCandidateCount` rollup per row via its own `LEFT JOIN`-style
 * query against `ProviderCandidate`. This page deliberately does NOT
 * duplicate that same query here: it would be a second, divergence-prone
 * copy of logic that already lives correctly in the route, and this list
 * page calls the repository directly (see above) rather than that route.
 * Each row links to the aggregator's detail page instead, where
 * `candidates-panel.tsx` fetches the live, authoritative candidate list —
 * a genuinely live count, not a rollup snapshot that could go stale between
 * this list render and a discovery run.
 */
import Link from 'next/link';
import { requireAdminAccess } from '@/lib/admin/access';
import { listAggregatorSources } from '@/lib/ingestion/aggregator/aggregator-repository';
import { RegisterAggregatorForm } from './register-form';
import { relativeDate, statusBadge, tosGateBadge } from './aggregators-view';

export const dynamic = 'force-dynamic';

export default async function AdminAggregatorsPage() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;

  const defaultCommunitySlug = auth.access.isAdmin ? 'denver' : (auth.access.communities[0] ?? 'denver');
  const aggregators = auth.access.isAdmin
    ? await listAggregatorSources(undefined).catch(() => [])
    : (
        await Promise.all(
          auth.access.communities.map((slug) => listAggregatorSources(slug).catch(() => [])),
        )
      ).flat();

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-bark-700">Aggregators</h1>
          <p className="text-bark-400 text-sm mt-1">
            {aggregators.length} aggregator{aggregators.length !== 1 ? 's' : ''} · third-party listing sites for
            candidate discovery
          </p>
        </div>
        <RegisterAggregatorForm defaultCommunitySlug={defaultCommunitySlug} />
      </div>

      {aggregators.length === 0 ? (
        <div className="glass-panel p-16 text-center">
          <p className="text-lg text-bark-300">No aggregators registered yet</p>
        </div>
      ) : (
        <div className="glass-panel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cream-300/60 text-xs uppercase tracking-wide text-bark-300">
                <th className="px-4 py-3 text-left font-semibold">Name</th>
                <th className="hidden px-4 py-3 text-left font-semibold md:table-cell">Status</th>
                <th className="px-4 py-3 text-left font-semibold">ToS Gate</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Community</th>
                <th className="hidden px-4 py-3 text-left font-semibold lg:table-cell">Registered</th>
              </tr>
            </thead>
            <tbody>
              {aggregators.map((aggregator, index) => {
                const status = statusBadge(aggregator.status);
                const tosGate = tosGateBadge(aggregator.tosDecision);
                return (
                  <tr
                    key={aggregator.id}
                    className={index % 2 === 0 ? 'bg-white/20' : 'bg-cream-50/30'}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/aggregators/${aggregator.id}`}
                        className="font-medium text-bark-700 transition-colors hover:text-pine-600"
                      >
                        {aggregator.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-bark-300 break-all">{aggregator.url}</p>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${tosGate.className}`}>
                        {tosGate.label}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-bark-400 sm:table-cell">{aggregator.communitySlug}</td>
                    <td className="hidden px-4 py-3 text-xs text-bark-400 lg:table-cell">{relativeDate(aggregator.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
