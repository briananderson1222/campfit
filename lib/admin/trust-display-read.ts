import { parseSnapshotSourceRef } from '@kontourai/traverse/fetch';

import { getPool } from '@/lib/db';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';
import { campfitVocabulary } from '@/lib/trust-vocabulary';

import { loadClaimBundle } from './claim-store';
import { resolveCitationText } from './citation-text';
import { citationTextKey, projectTrustDisplay, type TrustDisplay } from './trust-display';
import { campCanonicalClaimId } from './trust-projection';

/** Server-only composition boundary for presentation code. Missing or malformed
 * snapshots are intentionally omitted so the pure projector degrades honestly. */
export async function loadCampTrustDisplays(
  campId: string,
  fields?: readonly string[],
): Promise<{ camp: TrustDisplay; fields: Record<string, TrustDisplay> }> {
  const bundle = await loadClaimBundle(getPool(), [{ subjectType: campfitVocabulary.subjectType, subjectId: campId }]);
  const snapshotBodies: Record<string, string> = {};
  const store = createCampfitSnapshotStore();

  // One entry per distinct citation text: the raw body of a snapshot, or the
  // prepared text an extraction read from it (re-derived and digest-checked;
  // an unreproducible one is omitted, which shows as stale, never as verified).
  const byKey = new Map(bundle.evidence.filter((item) => item.sourceRef).map((item) => [citationTextKey(item), item] as const));
  await Promise.all([...byKey].map(async ([key, evidence]) => {
    const parsed = parseSnapshotSourceRef(evidence.sourceRef);
    if (!parsed) return;
    const snapshot = await store.get(parsed.sourceId, parsed.bodyHash);
    if (!snapshot || snapshot.bodyHash !== parsed.bodyHash || snapshot.url !== parsed.url || snapshot.fetchedAt !== parsed.fetchedAt) return;
    const citation = resolveCitationText({
      snapshotRef: evidence.sourceRef,
      snapshot,
      preparedArtifact: evidence.metadata?.citationSpace === 'prepared' ? evidence.metadata.preparedArtifact : undefined,
    });
    if (citation.ok) snapshotBodies[key] = citation.text;
  }));

  const selectedFields = fields ?? bundle.claims
    .map((claim) => claim.id.match(new RegExp(`^camp\\.${campId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.field\\.(.+)$`))?.[1])
    .filter((field): field is string => Boolean(field));
  const projectedFields = Object.fromEntries(selectedFields.map((field) => [
    field,
    projectTrustDisplay(bundle, snapshotBodies, campCanonicalClaimId(campId, field)),
  ]));

  // There is no single authored overall-camp Evidence claim in today's
  // ClaimStore. A field citation must never promote the whole camp badge.
  return {
    camp: { evidenceState: 'unverified', trustOrigin: 'none', label: 'Unverified', accessibleName: 'Unverified; no canonical overall-camp evidence claim' },
    fields: projectedFields,
  };
}
