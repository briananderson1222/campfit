import type { ProposedChanges } from '@/lib/admin/types';
import { isFreshDiscoveryProposal } from '@/lib/admin/proposal-classification';

export function NewCampMarker({ proposedChanges }: { proposedChanges: ProposedChanges }) {
  if (!isFreshDiscoveryProposal(proposedChanges)) return null;

  return (
    <span
      className="rounded-full bg-pine-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-pine-700 admin-chip"
      data-new-camp-marker="true"
    >
      New camp
    </span>
  );
}
