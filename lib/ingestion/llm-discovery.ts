/** Traverse-backed listing discovery. */
import type { ExtractionProvider } from "@kontourai/traverse";
import { parseSnapshotSourceRef, type FetchMode, type FetchSourceOptions, type SnapshotStore } from "@kontourai/traverse/fetch";
import { DISCOVERY_FIELD_HINTS, DISCOVERY_TARGET_SCHEMA } from "./discovery-schema";
import { groupDiscoveryItems } from "./discovery-item-grouping";
import { fetchAndExtractWithRevalidation } from "./traverse-fetch-extract";
import { CAMPFIT_FETCH_USER_AGENT } from "./traverse-snapshot-store";
import { createGuardedTraverseFetchOptions, type EgressPolicyProfile } from "@/lib/security/egress-url-policy";

export interface DiscoveredCampStub {
  name: string;
  detailUrl: string | null;
  snippet: string | null;
  excerpt: string;
  locator: string;
  nameExcerpt: string;
  nameLocator: string;
  detailUrlExcerpt: string | null;
  detailUrlLocator: string | null;
  sourceUrl: string;
  sourceRef: string;
}

export interface DiscoveryResult {
  isListingPage: boolean;
  stubs: DiscoveredCampStub[];
  model: string;
  unchanged?: boolean;
  warnings?: string[];
  error?: string;
  /** Raw evidence retained for Lookout observation/event derivation. */
  proposals?: readonly import("@kontourai/traverse").ExtractionProposal[];
  sourceRef?: string;
}

export interface DiscoveryOptions {
  provider: ExtractionProvider;
  store: SnapshotStore;
  mode?: FetchMode;
  fetchOptions?: FetchSourceOptions;
  revalidate?: boolean;
  maxChars?: number;
  maxProviderCalls?: number;
  maxTotalTokens?: number;
  egressProfile?: EgressPolicyProfile;
}

export async function discoverCampsFromUrl(url: string, options: DiscoveryOptions): Promise<DiscoveryResult> {
  const model = options.provider.name;
  try {
    const result = await fetchAndExtractWithRevalidation(
      { id: `campfit-discovery:${url}`, url, contentType: "html", userAgent: CAMPFIT_FETCH_USER_AGENT },
      {
        targetSchema: DISCOVERY_TARGET_SCHEMA,
        fieldHints: DISCOVERY_FIELD_HINTS,
        provider: options.provider,
        store: options.store,
        mode: options.mode ?? "live-with-capture",
        prep: "markdown",
        maxContentChars: options.maxChars,
        // Match the established per-source traverse backstops. Callers may
        // lower either ceiling, but discovery is never silently unbounded.
        maxProviderCalls: options.maxProviderCalls ?? 40,
        maxTotalTokens: options.maxTotalTokens ?? 450_000,
        fetchOptions: (options.mode ?? "live-with-capture") === "replay"
          ? options.fetchOptions
          : createGuardedTraverseFetchOptions(options.fetchOptions, options.egressProfile ?? "storedCrawlTarget"),
      },
      options.revalidate === true,
    );

    if (result.fetch.snapshot?.notModified) {
      return { isListingPage: true, stubs: [], model, unchanged: true, warnings: result.fetch.warnings };
    }
    if (result.fetch.error || !result.fetch.snapshot) {
      const detail = result.fetch.error?.message ?? "no snapshot returned";
      return { isListingPage: false, stubs: [], model, error: `Fetch failed: ${detail}` };
    }
    if (!result.extraction) {
      return { isListingPage: false, stubs: [], model, error: "Extraction failed: no extraction result" };
    }
    if (result.extraction.error) {
      return { isListingPage: false, stubs: [], model, error: `Extraction failed: ${result.extraction.error}` };
    }
    if (!result.sourceRef) {
      return { isListingPage: false, stubs: [], model, error: "Extraction failed: snapshot source ref missing" };
    }

    const sourceUrl = result.fetch.snapshot.url;
    const grouped = groupDiscoveryItems(result.extraction.proposals, sourceUrl);
    const stubs = grouped.items.map((item) => ({ ...item, sourceUrl, sourceRef: result.sourceRef! }));
    return {
      isListingPage: stubs.length >= 2,
      stubs,
      model: result.extraction.raw?.model ?? model,
      warnings: [...(result.fetch.warnings ?? []), ...(result.extraction.warnings ?? []), ...grouped.warnings],
      proposals: result.extraction.proposals,
      sourceRef: result.sourceRef,
    };
  } catch (error) {
    return { isListingPage: false, stubs: [], model, error: `Discovery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function filterNewDiscoveries(
  stubs: DiscoveredCampStub[],
  existingNames: string[],
  threshold = 0.75
): DiscoveredCampStub[] {
  return stubs.filter(stub => {
    for (const existing of existingNames) {
      if (diceCoefficient(stub.name, existing) >= threshold) return false;
    }
    return true;
  });
}

function bigrams(str: string): Set<string> {
  const s = str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const result = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) result.add(s.slice(i, i + 2));
  return result;
}

function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  ba.forEach(gram => { if (bb.has(gram)) intersection++; });
  return (2 * intersection) / (ba.size + bb.size);
}

export interface DiscoveryObservation {
  excerpt: string;
  locator: string;
  sourceUrl: string;
  sourceRef: string;
}

export function buildDiscoveryFieldSources(stub: DiscoveredCampStub): Record<string, DiscoveryObservation> {
  if (
    !stub.excerpt
    || !/^chars:\d+-\d+$/.test(stub.locator)
    || !stub.nameExcerpt
    || !/^chars:\d+-\d+$/.test(stub.nameLocator)
    || !parseSnapshotSourceRef(stub.sourceRef)
  ) {
    throw new Error(`Discovery stub "${stub.name}" lacks verified snapshot provenance`);
  }
  const nameObservation = {
    excerpt: stub.nameExcerpt,
    locator: stub.nameLocator,
    sourceUrl: stub.sourceUrl,
    sourceRef: stub.sourceRef,
  };
  if (!stub.detailUrl) return { name: nameObservation };
  if (!stub.detailUrlExcerpt || !stub.detailUrlLocator || !/^chars:\d+-\d+$/.test(stub.detailUrlLocator)) {
    throw new Error(`Discovery stub "${stub.name}" lacks verified website URL provenance`);
  }
  return {
    name: nameObservation,
    websiteUrl: {
      excerpt: stub.detailUrlExcerpt,
      locator: stub.detailUrlLocator,
      sourceUrl: stub.sourceUrl,
      sourceRef: stub.sourceRef,
    },
  };
}
