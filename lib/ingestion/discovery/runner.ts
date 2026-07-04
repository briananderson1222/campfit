/**
 * lib/ingestion/discovery/runner.ts — the discovery orchestration (I22 / #52).
 *
 * runDiscovery ties the pieces together for one source run:
 *   1. source.discover()              — raw candidates + provenance
 *   2. Denver-metro boundary filter   — out-of-metro candidates excluded (R1/AC1)
 *   3. dedupe classification          — against onboarded providers AND already-
 *                                       queued candidates (R2/AC2)
 *   4. enqueueCandidate               — new + near-duplicate candidates land in
 *                                       the queue with provenance (R4); exact
 *                                       duplicates are skipped.
 *
 * It NEVER creates a Provider — onboarding is a separate, human-triggered action
 * (approveProviderCandidate). The returned summary is the AC1 evidence surface.
 */
import type { Pool } from "pg";

import { getPool } from "@/lib/db";
import { classifyCandidate, normalizeDomain } from "./dedupe";
import { isDenverMetro } from "./denver-metro";
import {
  enqueueCandidate,
  ensureProviderCandidateSchema,
  listPendingCandidateDedupeTargets,
  listProviderDedupeTargets,
} from "./candidate-repository";
import type { DiscoverySource, RawProviderCandidate } from "./types";

export interface DiscoveryOutcome {
  candidate: RawProviderCandidate;
  disposition:
    | "enqueued-new"
    | "enqueued-near-duplicate"
    | "skipped-duplicate"
    | "excluded-out-of-metro";
  detail: string | null;
  /** Populated for enqueued dispositions. */
  candidateId?: string;
}

export interface DiscoverySummary {
  sourceKey: string;
  sourceLabel: string;
  communitySlug: string;
  discoveryQuery: string;
  retrievedAt: Date;
  discovered: number;
  excludedOutOfMetro: number;
  enqueuedNew: number;
  enqueuedNearDuplicate: number;
  skippedDuplicate: number;
  outcomes: DiscoveryOutcome[];
}

export interface RunDiscoveryOptions {
  /** When true, classify and report but write nothing. */
  dryRun?: boolean;
  pool?: Pool;
}

export async function runDiscovery(
  source: DiscoverySource,
  options: RunDiscoveryOptions = {},
): Promise<DiscoverySummary> {
  const pool = options.pool ?? getPool();
  const dryRun = options.dryRun ?? false;

  const result = await source.discover();

  // Idempotent — creates the empty queue table if the additive migration 013
  // has not been applied yet. Safe in dry-run too (no rows are written); it
  // lets dry-run read the existing queue to report accurate dispositions.
  await ensureProviderCandidateSchema(pool);

  // Dedupe targets are loaded once up front; near-duplicate matching stays
  // against the onboarded-provider snapshot, while exact matching also folds in
  // candidates enqueued earlier in THIS run so intra-run duplicates are caught.
  const providers = await listProviderDedupeTargets(source.communitySlug, pool);
  const queued = await listPendingCandidateDedupeTargets(source.communitySlug, pool);

  const summary: DiscoverySummary = {
    sourceKey: source.key,
    sourceLabel: source.label,
    communitySlug: source.communitySlug,
    discoveryQuery: result.discoveryQuery,
    retrievedAt: result.retrievedAt,
    discovered: result.candidates.length,
    excludedOutOfMetro: 0,
    enqueuedNew: 0,
    enqueuedNearDuplicate: 0,
    skippedDuplicate: 0,
    outcomes: [],
  };

  for (const raw of result.candidates) {
    // (1) Metro boundary — hard scope. Out-of-metro is excluded, not queued.
    if (!isDenverMetro(raw.city)) {
      summary.excludedOutOfMetro++;
      summary.outcomes.push({
        candidate: raw,
        disposition: "excluded-out-of-metro",
        detail: `city "${raw.city ?? "(unknown)"}" is outside the Denver metro`,
      });
      continue;
    }

    // (2) Dedupe classification.
    const domain = normalizeDomain(raw.websiteUrl);
    const verdict = classifyCandidate({ name: raw.name, domain }, providers, queued);

    if (verdict.kind === "exact-duplicate") {
      summary.skippedDuplicate++;
      summary.outcomes.push({
        candidate: raw,
        disposition: "skipped-duplicate",
        detail: `${verdict.reason} — matches "${verdict.matched.name}"`,
      });
      continue;
    }

    // (3) Enqueue new + near-duplicate candidates with provenance.
    const nearMatch = verdict.kind === "near-duplicate" ? verdict : null;
    if (dryRun) {
      summary.outcomes.push({
        candidate: raw,
        disposition: nearMatch ? "enqueued-near-duplicate" : "enqueued-new",
        detail: nearMatch ? nearMatch.reason : null,
      });
      // Mirror the write path's in-run dedupe so dry-run reporting matches a
      // real run (a later identical entry reports as skipped-duplicate).
      queued.push({ id: `dry-${queued.length}`, name: raw.name, domain });
    } else {
      const row = await enqueueCandidate(
        {
          name: raw.name,
          websiteUrl: raw.websiteUrl,
          city: raw.city,
          neighborhood: raw.neighborhood ?? null,
          communitySlug: source.communitySlug,
          sourceKey: source.key,
          sourceLabel: source.label,
          discoveryQuery: result.discoveryQuery,
          retrievedAt: result.retrievedAt,
          possibleDuplicateOfProviderId: nearMatch ? nearMatch.matched.id : null,
          possibleDuplicateOfName: nearMatch ? nearMatch.matched.name : null,
          duplicateReason: nearMatch ? nearMatch.reason : null,
        },
        pool,
      );
      summary.outcomes.push({
        candidate: raw,
        disposition: nearMatch ? "enqueued-near-duplicate" : "enqueued-new",
        detail: nearMatch ? nearMatch.reason : null,
        candidateId: row.id,
      });
      // Fold this candidate into the in-run dedupe set so a later duplicate in
      // the same source list is caught as an exact duplicate.
      queued.push({ id: row.id, name: raw.name, domain });
    }

    if (nearMatch) summary.enqueuedNearDuplicate++;
    else summary.enqueuedNew++;
  }

  return summary;
}
