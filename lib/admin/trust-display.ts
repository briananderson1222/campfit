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
}

export function projectTrustDisplay(
  bundle: TrustBundle,
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
        snapshotBodies[evidence.sourceRef],
        evidence.sourceLocator,
      );
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
