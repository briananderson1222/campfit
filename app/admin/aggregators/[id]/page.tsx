/**
 * app/admin/aggregators/[id]/page.tsx — aggregator detail shell
 * (campfit#93, Wave 3 Task 3.2 + Wave 4 Task 4.2's wiring into this file's
 * reserved slot).
 *
 * Fetches `getAggregatorSource(id)` directly (same "Server Component calls
 * the repository, not its own API route" convention
 * `app/admin/providers/[providerId]/page.tsx` already uses for
 * `getProvider`) — `notFound()` for a missing row. Auth uses the row's own
 * `communitySlug` (an `AggregatorSource` column, unlike `Provider` which
 * needs a separate `getProviderCommunitySlug` lookup) — fetched BEFORE the
 * auth check here (opposite order from the provider page, which looks up
 * just the slug first) since `getAggregatorSource` returns the full row in
 * one query anyway; either order returns an identical `notFound()` with no
 * body on failure, so this reordering leaks no additional information.
 *
 * Renders, top to bottom: the ToS-gate status (always visible, per the
 * deliver instruction's "gate status must be prominent") — either the
 * prominent unrecorded-decision card (`TosDecisionForm mode="initial"`) or
 * a read-only decision receipt PLUS a collapsed re-decide form; the
 * "Run discovery" affordance (`RunDiscoveryButton`, disabled until
 * APPROVED); and the candidates curation panel (`CandidatesPanel`).
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSource } from '@/lib/ingestion/aggregator/aggregator-repository';
import { relativeDate, statusBadge, isTosApproved } from '../aggregators-view';
import { TosDecisionForm } from './tos-decision-form';
import { RunDiscoveryButton } from './run-discovery-button';
import { CandidatesPanel } from './candidates-panel';
import { TosReceiptWithRedecide } from './tos-receipt';

export const dynamic = 'force-dynamic';

export default async function AggregatorDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  const aggregator = await getAggregatorSource(id).catch(() => null);
  if (!aggregator) notFound();

  const auth = await requireAdminAccess({ communitySlug: aggregator.communitySlug, allowModerator: true });
  if ('error' in auth) notFound();

  const status = statusBadge(aggregator.status);
  const tosApproved = isTosApproved(aggregator.tosDecision);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 text-xs text-bark-300 mb-1">
          <Link href="/admin/aggregators" className="hover:text-pine-500 transition-colors">Aggregators</Link>
          <span>/</span>
          <span className="text-bark-400 truncate">{aggregator.name}</span>
        </div>
        <h1 className="font-display text-3xl font-extrabold text-bark-700 leading-tight">{aggregator.name}</h1>
        <div className="flex flex-wrap items-center gap-3 mt-2">
          <a
            href={aggregator.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-bark-400 hover:text-pine-500 transition-colors"
          >
            {aggregator.url}
            <ExternalLink className="w-3 h-3" />
          </a>
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>
            {status.label}
          </span>
          <span className="text-xs text-bark-400">{aggregator.communitySlug}</span>
          <span className="text-xs text-bark-400">
            Registered {relativeDate(aggregator.createdAt)}
          </span>
        </div>
      </div>

      {/* ToS gate (R1/AC1) — always the first thing rendered below the
          header, per the deliver instruction that gate status must be
          prominent. */}
      {aggregator.tosDecision === null ? (
        <TosDecisionForm aggregatorId={aggregator.id} mode="initial" />
      ) : (
        <TosReceiptWithRedecide aggregator={aggregator} />
      )}

      {/* Run discovery + curation (Wave 4, Task 4.2) */}
      <RunDiscoveryButton aggregatorId={aggregator.id} tosApproved={tosApproved} />
      <CandidatesPanel aggregatorId={aggregator.id} />
    </div>
  );
}
