import { parseAnySnapshotSourceRef, type Snapshot, type SnapshotStore } from '@kontourai/traverse/fetch';

import { isSnapshotIntact } from '@/lib/ingestion/snapshot-integrity';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';

import { resolveCitationText } from './citation-text';
import { resolveReviewExcerpt } from './review-excerpt-resolution';
import type { CampChangeProposal } from './types';

type ShadowSnapshotProposal = Pick<
  CampChangeProposal,
  'snapshotRef' | 'snapshotBodyHash' | 'proposedChanges'
> & {
  /** The prepared-text identity the extraction recorded (`rawExtraction.preparedArtifact`), when it did. */
  readonly preparedArtifact?: unknown;
};

/** Pure exact-evidence check once the immutable snapshot bytes are available. */
export function isProposalSnapshotResolved(
  proposal: Pick<CampChangeProposal, 'proposedChanges'>,
  snapshotBody: string | null | undefined,
): boolean {
  const diffs = Object.values(proposal.proposedChanges);
  return diffs.length > 0 && diffs.every((diff) =>
    typeof diff.excerpt === 'string'
    && resolveReviewExcerpt(diff.excerpt, snapshotBody, diff.locator).state === 'verified'
  );
}

async function resolveWithStore(
  proposal: ShadowSnapshotProposal,
  getSnapshot: (sourceId: string, bodyHash: string) => Promise<Snapshot | undefined>,
): Promise<boolean> {
  try {
    if (!proposal.snapshotRef || !proposal.snapshotBodyHash) return false;
    const parsed = parseAnySnapshotSourceRef(proposal.snapshotRef);
    if (!parsed
      || !/^[a-f0-9]{64}$/i.test(parsed.bodyHash)
      || parsed.bodyHash !== proposal.snapshotBodyHash) return false;

    const snapshot = await getSnapshot(parsed.sourceId, parsed.bodyHash);
    if (!snapshot
      || snapshot.sourceId !== parsed.sourceId
      || snapshot.bodyHash !== parsed.bodyHash
      || snapshot.url !== parsed.url
      || snapshot.fetchedAt !== parsed.fetchedAt
      // The hash is re-derived on the basis it was taken over (response bytes
      // for a Traverse 5 capture, UTF-8 of the body for an earlier one), and a
      // byte-hashed body must be the decode of those bytes.
      || !isSnapshotIntact(snapshot)) return false;
    // Excerpts are checked against the text the extraction read (see
    // citation-text.ts); a prepared text that cannot be reproduced exactly
    // resolves nothing.
    const citation = resolveCitationText({ snapshotRef: proposal.snapshotRef, snapshot, preparedArtifact: proposal.preparedArtifact });
    return citation.ok && isProposalSnapshotResolved(proposal, citation.text);
  } catch {
    return false;
  }
}

/** Resolve one proposal with a caller-supplied store; failures are closed. */
export async function resolveProposalSnapshot(
  proposal: ShadowSnapshotProposal,
  store: SnapshotStore = createCampfitSnapshotStore(),
): Promise<boolean> {
  return resolveWithStore(proposal, (sourceId, bodyHash) => store.get(sourceId, bodyHash));
}

/**
 * Shared bulk resolver for queue/report reads. It constructs one store,
 * bounds active resolution work, and caches immutable snapshot reads by
 * source-id/hash while preserving input order. Each proposal fails closed
 * independently.
 */
export async function resolveProposalSnapshots(
  proposals: readonly ShadowSnapshotProposal[],
  options: { readonly concurrency?: number; readonly store?: SnapshotStore } = {},
): Promise<boolean[]> {
  if (proposals.length === 0) return [];
  const store = options.store ?? createCampfitSnapshotStore();
  const concurrency = Number.isSafeInteger(options.concurrency) && (options.concurrency ?? 0) > 0
    ? Math.min(options.concurrency!, proposals.length)
    : Math.min(8, proposals.length);
  const snapshotCache = new Map<string, Promise<Snapshot | undefined>>();
  const getSnapshot = (sourceId: string, bodyHash: string) => {
    const key = `${sourceId}\0${bodyHash}`;
    const cached = snapshotCache.get(key);
    if (cached) return cached;
    const pending = store.get(sourceId, bodyHash).catch(() => undefined);
    snapshotCache.set(key, pending);
    return pending;
  };
  const results = new Array<boolean>(proposals.length).fill(false);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < proposals.length) {
      const index = nextIndex++;
      results[index] = await resolveWithStore(proposals[index]!, getSnapshot);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
