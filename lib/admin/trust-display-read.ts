import { parseSnapshotSourceRef } from '@kontourai/traverse/fetch';

import { getPool } from '@/lib/db';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';
import { campfitVocabulary } from '@/lib/trust-vocabulary';

import { loadClaimBundle } from './claim-store';
import { projectTrustDisplay, type TrustDisplay } from './trust-display';
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

  await Promise.all([...new Set(bundle.evidence.map((item) => item.sourceRef).filter(Boolean))].map(async (sourceRef) => {
    const parsed = parseSnapshotSourceRef(sourceRef);
    if (!parsed) return;
    const snapshot = await store.get(parsed.sourceId, parsed.bodyHash);
    if (snapshot && snapshot.bodyHash === parsed.bodyHash && snapshot.url === parsed.url && snapshot.fetchedAt === parsed.fetchedAt) {
      snapshotBodies[sourceRef] = snapshot.body;
    }
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
