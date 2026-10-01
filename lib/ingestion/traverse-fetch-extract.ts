import { extract } from "@kontourai/traverse";
import {
  buildSnapshotSourceRef,
  fetchAndExtract,
  fetchSource,
  type FetchAndExtractOptions,
  type FetchAndExtractResult,
  type FetchSourceOptions,
  type SourceConfig,
} from "@kontourai/traverse/fetch";

import { fingerprintSnapshotContent } from "./content-fingerprint";

/**
 * Opt a revalidating call into the unchanged-content check. `priorFingerprint`
 * is the fingerprint the last COMPLETE extraction of this source recorded
 * (content-fingerprint.ts), or `null` when none is on record.
 */
export interface UnchangedContentCheck {
  readonly priorFingerprint: string | null;
}

export type FetchAndExtractOutcome = FetchAndExtractResult & {
  /** Fingerprint of the fetched snapshot's prepared text. Present only with an {@link UnchangedContentCheck}. */
  contentFingerprint?: string;
  /** The fingerprint equals `priorFingerprint`: extraction was skipped, no provider call was made. */
  contentUnchanged?: true;
};

/**
 * Generic fetch/extract composition with the CampFit-specific decision of
 * when a fetched page needs no provider call. Non-revalidating calls use
 * traverse's composition unchanged.
 *
 * Without `unchanged`: a trustworthy 304 returns before extraction.
 *
 * With `unchanged`: the decision is made on what the extraction would read,
 * not on the HTTP status. The snapshot (a fresh 200, or the prior body a 304
 * re-served) is fingerprinted; extraction is skipped only when that equals the
 * fingerprint of the last complete extraction. So an unchanged page whose raw
 * HTML differs on every fetch is still skipped, and a 304 against a snapshot
 * that was captured but never extracted (an earlier run that failed) is still
 * extracted instead of being skipped forever.
 */
export async function fetchAndExtractWithRevalidation(
  config: SourceConfig,
  opts: FetchAndExtractOptions,
  revalidate = false,
  unchanged?: UnchangedContentCheck,
): Promise<FetchAndExtractOutcome> {
  if (!revalidate || (opts.mode ?? "live") === "replay" || config.render) {
    return fetchAndExtract(config, opts);
  }

  const fetchOptions: FetchSourceOptions = { ...(opts.fetchOptions ?? {}) };
  if (opts.store && fetchOptions.store === undefined) fetchOptions.store = opts.store;
  const fetchResult = await fetchSource({ ...config, revalidate: true }, fetchOptions);

  if ((opts.mode ?? "live") === "live-with-capture" && fetchResult.snapshot && opts.store) {
    await opts.store.put(fetchResult.snapshot);
  }
  if (!fetchResult.snapshot) return { fetch: fetchResult };

  const snapshot = fetchResult.snapshot;
  const sourceRef = buildSnapshotSourceRef(snapshot);
  if (!unchanged && snapshot.notModified) return { fetch: fetchResult, sourceRef };

  const contentFingerprint = unchanged
    ? fingerprintSnapshotContent(snapshot.bodyBytes ?? snapshot.body, snapshot.contentType, {
        targetSchema: opts.targetSchema,
        fieldHints: opts.fieldHints,
      })
    : undefined;
  if (unchanged && contentFingerprint !== undefined && contentFingerprint === unchanged.priorFingerprint) {
    return { fetch: fetchResult, sourceRef, contentFingerprint, contentUnchanged: true };
  }

  const extraction = await extract({
    content: snapshot.bodyBytes ?? snapshot.body,
    contentType: snapshot.contentType,
    sourceRef,
    targetSchema: opts.targetSchema,
    provider: opts.provider,
    fieldHints: opts.fieldHints,
    maxContentChars: opts.maxContentChars,
    prep: opts.prep,
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    maxChunks: opts.maxChunks,
    maxProviderCalls: opts.maxProviderCalls,
    maxTotalTokens: opts.maxTotalTokens,
    pdfTextExtractor: opts.pdfTextExtractor,
    imageTextExtractor: opts.imageTextExtractor,
    // Binds the prepared-text identity to this snapshot, as traverse's own
    // `fetchAndExtract` does, so a citation check can prove which text an
    // excerpt was cut from (lib/admin/citation-text.ts).
    preparedArtifact: {
      store: opts.preparedArtifactStore,
      sourceSnapshotRef: sourceRef,
      preparationVersion: opts.preparationVersion,
    },
  });
  return { fetch: fetchResult, extraction, sourceRef, ...(contentFingerprint === undefined ? {} : { contentFingerprint }) };
}
