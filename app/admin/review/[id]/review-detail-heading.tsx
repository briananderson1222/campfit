import type { CampChangeProposal } from '@/lib/admin/types';
import { isFreshDiscoveryProposal, proposedCampName } from '@/lib/admin/proposal-classification';

export function ReviewDetailHeading({ proposal }: { proposal: CampChangeProposal }) {
  if (!isFreshDiscoveryProposal(proposal.proposedChanges)) {
    return <h1 className="font-display text-2xl font-extrabold text-bark-700">{proposal.campName}</h1>;
  }

  return (
    <div data-review-new-camp="true">
      <span className="mb-1 inline-flex rounded-full bg-pine-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-pine-700 admin-chip">
        NEW CAMP
      </span>
      <h1 className="font-display text-2xl font-extrabold text-bark-700">
        Review new camp: {proposedCampName(proposal.proposedChanges, proposal.campName)}
      </h1>
    </div>
  );
}
