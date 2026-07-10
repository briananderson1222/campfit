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

/**
 * Generic fetch/extract composition with the one CampFit-specific decision
 * needed by conditional callers: a trustworthy 304 returns before provider
 * extraction. Non-revalidating calls use traverse's composition unchanged.
 */
export async function fetchAndExtractWithRevalidation(
  config: SourceConfig,
  opts: FetchAndExtractOptions,
  revalidate = false,
): Promise<FetchAndExtractResult> {
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
  if (snapshot.notModified) return { fetch: fetchResult, sourceRef };

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
  });
  return { fetch: fetchResult, extraction, sourceRef };
}
