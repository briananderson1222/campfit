import { foldClaim, type Evidence, type TrustBundle, type VerificationEvent } from '@kontourai/surface';
import { resolveReviewExcerpt } from './review-excerpt-resolution';

export type TrustOrigin = 'crawl' | 'human' | 'none';
export type EvidenceState = 'verified_current' | 'attested_no_source' | 'stale_unresolvable' | 'unverified';

export interface TrustDisplay {
  evidenceState: EvidenceState;
  trustOrigin: TrustOrigin;
  label: string;
  accessibleName: string;
  actor?: string;
  at?: string;
  reason?: string;
  sourceRef?: string;
  locator?: string;
  excerpt?: string;
  /** Set when the value was accepted in a batch by the exact-corroboration rule, not reviewed one by one. */
  acceptedInBatch?: true;
}

/**
 * Key of the text an evidence record's locator indexes, in the map passed to
 * {@link projectTrustDisplay}. Evidence approved from a proposal that recorded
 * its prepared text cites that text (`metadata.citationSpace === 'prepared'`),
 * identified by the snapshot AND the prepared-artifact ref; all other evidence
 * cites the raw snapshot body, keyed by `sourceRef` alone as before.
 */
export function citationTextKey(evidence: Pick<Evidence, 'sourceRef' | 'metadata'>): string {
  const artifactRef = (evidence.metadata?.preparedArtifact as { ref?: unknown } | undefined)?.ref;
  return evidence.metadata?.citationSpace === 'prepared' && typeof artifactRef === 'string'
    ? `${evidence.sourceRef}\n${artifactRef}`
    : evidence.sourceRef ?? '';
}

export function projectTrustDisplay(
  bundle: TrustBundle,
  /** Citation texts keyed by {@link citationTextKey}. A missing entry degrades to "stale / unresolvable". */
  snapshotBodies: Readonly<Record<string, string | undefined>>,
  claimId?: string,
  now: Date = new Date(),
): TrustDisplay {
  const claims = bundle.claims.filter((claim) => !claimId || claim.id === claimId);
  for (const claim of claims) {
    const claimEvidence = bundle.evidence.filter((item) => item.claimId === claim.id);
    const claimEvents = bundle.events.filter((item) => item.claimId === claim.id);
    const folded = foldClaim({ claim, evidence: claimEvidence, policies: bundle.policies, events: claimEvents, allEvents: bundle.events, now, checkpointUsable: false, checkpointSeenClaim: false });
    const entailingIds = new Set(folded.entailingEvidence.map((item) => item.id));
    const event = [...claimEvents]
      .filter((item) => item.status === folded.ownStatus && item.type !== 'invalidation' && item.evidenceIds.some((id) => entailingIds.has(id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!event) continue;
    const evidence = event.evidenceIds
      .map((id) => folded.entailingEvidence.find((item) => item.id === id))
      .filter((item): item is Evidence => Boolean(item)).at(-1);
    if (!evidence) continue;
    const mode = evidence.metadata?.mode;
    if (folded.ownStatus !== 'verified' && !(folded.ownStatus === 'assumed' && mode === 'override')) continue;
    const origin: TrustOrigin = evidence.method === 'attestation' ? 'human' : 'crawl';
    const actor = event.actor || evidence.collectedBy;
    const at = event.verifiedAt ?? event.createdAt ?? evidence.observedAt;

    if (mode === 'override') {
      const reason = typeof evidence.metadata?.reason === 'string' ? evidence.metadata.reason : event.notes;
      return {
        evidenceState: 'attested_no_source', trustOrigin: 'human', label: 'Attested — no source',
        accessibleName: `Attested without source by ${actor}${at ? ` at ${at}` : ''}${reason ? `: ${reason}` : ''}`,
        actor, at, reason,
      };
    }

    if (evidence.sourceRef && evidence.sourceLocator && evidence.excerptOrSummary) {
      const resolution = resolveReviewExcerpt(
        evidence.excerptOrSummary,
        snapshotBodies[citationTextKey(evidence)],
        evidence.sourceLocator,
      );
      // A batch accept is its own kind of decision; say so instead of
      // presenting it as an individual review.
      const batch = evidence.metadata?.reviewKind === 'batch-accept' || event.method === 'batch-accept';
      if (resolution.state === 'verified' && batch) {
        return {
          evidenceState: 'verified_current', trustOrigin: origin, label: 'Accepted in batch', acceptedInBatch: true,
          accessibleName: `Accepted in a batch by the exact-corroboration rule (${actor}); the cited excerpt is on the current source page`,
          actor, at, sourceRef: evidence.sourceRef, locator: resolution.locator, excerpt: evidence.excerptOrSummary,
        };
      }
      if (resolution.state === 'verified') {
        return {
          evidenceState: 'verified_current', trustOrigin: origin, label: 'Verified',
          accessibleName: `Verified from current source evidence by ${actor}`,
          actor, at, sourceRef: evidence.sourceRef, locator: resolution.locator, excerpt: evidence.excerptOrSummary,
        };
      }
      return {
        evidenceState: 'stale_unresolvable', trustOrigin: origin, label: 'Stale / unresolvable',
        accessibleName: `Source evidence is stale or unresolvable; previously recorded by ${actor}`,
        actor, at, sourceRef: evidence.sourceRef, locator: evidence.sourceLocator, excerpt: evidence.excerptOrSummary,
      };
    }
  }

  return { evidenceState: 'unverified', trustOrigin: 'none', label: 'Unverified', accessibleName: 'Unverified; no current evidence' };
}
