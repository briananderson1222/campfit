import { buildSnapshotSourceRef, parseSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { ExactSnapshotLookupResult, ExactSnapshotStore, Snapshot, SnapshotLookup } from "@kontourai/forage/fetch";
import type { SnapshotStore } from "@kontourai/traverse/fetch";

/**
 * Lookout 0.7+ authenticates every observation's snapshot reference through
 * the snapshot store's `findExact` before it diffs or commits anything. CampFit
 * keeps its captures in Traverse-contract stores (Supabase Storage in
 * production, Traverse's filesystem store locally), and that contract has no
 * `findExact`: without one Lookout refuses every observation as malformed.
 *
 * This adds the exact lookup over the store's own `list`, matching Forage's
 * semantics: the full identity (source, URL, body hash, fetch time) must match,
 * with no hash-prefix matching, and a reference that carries an envelope digest
 * must match the digest Forage computes for the stored record. A store that
 * already has `findExact` is returned unchanged.
 *
 * Upstream: this goes away once Traverse's store contract carries Forage 1.0's
 * exact lookup.
 */
export function withExactSnapshotLookup(store: SnapshotStore): ExactSnapshotStore {
  const candidate = store as SnapshotStore & Partial<Pick<ExactSnapshotStore, "findExact">>;
  if (typeof candidate.findExact === "function") return candidate as unknown as ExactSnapshotStore;
  return {
    put: (snapshot) => store.put(snapshot as never),
    latest: (sourceId) => store.latest(sourceId) as Promise<Snapshot | undefined>,
    get: (sourceId, bodyHash) => store.get(sourceId, bodyHash) as Promise<Snapshot | undefined>,
    list: (sourceId) => store.list(sourceId) as Promise<Snapshot[]>,
    async findExact(reference: SnapshotLookup): Promise<ExactSnapshotLookupResult> {
      const matches = ((await store.list(reference.sourceId)) as Snapshot[]).filter(
        (snapshot) => snapshot.bodyHash === reference.bodyHash && snapshot.fetchedAt === reference.fetchedAt,
      );
      if (matches.length === 0) return { kind: "missing" };
      const [snapshot] = matches;
      if (matches.length > 1 || snapshot.sourceId !== reference.sourceId || snapshot.url !== reference.url) {
        return { kind: "mismatch" };
      }
      if (reference.snapshotDigest !== undefined && envelopeDigest(snapshot) !== reference.snapshotDigest) {
        return { kind: "mismatch" };
      }
      return { kind: "found", snapshot };
    },
  };
}

function envelopeDigest(snapshot: Snapshot): string | undefined {
  try {
    return parseSnapshotSourceRef(buildSnapshotSourceRef(snapshot))?.snapshotDigest;
  } catch {
    // A record Forage cannot reference (for example a corrupt body) has no digest.
    return undefined;
  }
}
