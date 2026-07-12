import { createCheckRunner, type CheckResult, type LookoutSource, type RenderPolicy, type ObservationStore, type ProposalSetObservation } from "@kontourai/lookout";
import type { FetchSource, CreateCheckRunnerOptions } from "@kontourai/lookout";
import type { ExtractionProposal } from "@kontourai/traverse";
import { fetchSource as traverseFetchSource } from "@kontourai/traverse/fetch";
import type { Camp } from "@/lib/types";
import { CAMPFIT_FETCH_USER_AGENT } from "./traverse-snapshot-store";
import { runTraverseRecrawlForCamp, type TraverseRecrawlOptions, type TraverseRecrawlResult } from "./traverse-recrawl-adapter";
import { createCampfitObservationStore, emitCampfitObservation, recoverPendingSurveyDelivery } from "./lookout-observation-store";
import { createGuardedTraverseFetchOptions, type EgressResolver } from "@/lib/security/egress-url-policy";

export { LOOKOUT_CADENCE_HINT, campToLookoutSource, listingToLookoutSource } from "./lookout-sources";
import { campToLookoutSource } from "./lookout-sources";

export interface RunLookoutCheckOptions extends Omit<CreateCheckRunnerOptions, "fetchSource"> {
  fetchSource: FetchSource;
  userAgent?: string;
  /** Deterministic threat-fixture seam; production uses the canonical resolver. */
  egressResolver?: EgressResolver;
}

/** Run the shipped classifier while restoring CampFit fetch policy omitted by Lookout 0.2.0. */
export async function runLookoutCheck(source: LookoutSource, options: RunLookoutCheckOptions): Promise<CheckResult> {
  const fetchSource: FetchSource = (config, fetchOptions) => options.fetchSource({
    ...config,
    contentType: "html",
    userAgent: options.userAgent ?? CAMPFIT_FETCH_USER_AGENT,
    ...(source.renderPolicy === "always" ? { render: true, revalidate: false } : {}),
  }, fetchOptions);
  const fetchOptions = createGuardedTraverseFetchOptions(
    options.fetchOptions,
    "storedCrawlTarget",
    { resolver: options.egressResolver },
  );
  return createCheckRunner({ ...options, fetchOptions, fetchSource }).check(source);
}

export function isLookoutUnchanged(result: CheckResult): boolean {
  return result.kind === "unchanged-304" || result.kind === "unchanged-hash";
}

/**
 * Complete known-camp coordinator. CHECK owns the live fetch/classification;
 * changed extraction replays the exact snapshot already committed by CHECK,
 * so no parallel or unclassified network fetch occurs. The replay adapter's
 * D1-backed computeDiff remains the DB-current review authority.
 */
export async function runLookoutRecrawlForCamp(
  options: TraverseRecrawlOptions,
  deps: { fetchSource?: FetchSource; clock?: () => string; observationStore?: ObservationStore; surveySpoolRoot?: string; replayCamp?: typeof runTraverseRecrawlForCamp; emissionFaults?: { beforeObservationCommit?: () => void; beforeSurveyFinalize?: () => void } } = {},
): Promise<TraverseRecrawlResult> {
  const policy: RenderPolicy = options.requiresRender ? "always" : "on-shell-warning";
  const source = campToLookoutSource(options.current, policy);
  const replayCamp = deps.replayCamp ?? runTraverseRecrawlForCamp;
  // Resolve the default exactly once. Loading through one ephemeral default
  // and emitting through another made baseline behavior depend on an
  // implementation detail of the store factory rather than one coordinator-
  // owned store instance.
  const observationStore = deps.observationStore ?? createCampfitObservationStore();
  // Reconcile the pointer-advanced/finalize-failed crash window before CHECK.
  // This must run even when every subsequent response is a permanent 304.
  try {
    await recoverPendingSurveyDelivery(source.id, observationStore, deps.surveySpoolRoot);
  } catch (cause) {
    return failed(options, `lookout-recovery:${cause instanceof Error ? cause.message : String(cause)}`);
  }
  let checked = await runLookoutCheck(source, {
    store: options.store,
    fetchSource: deps.fetchSource ?? traverseFetchSource,
    fetchOptions: options.fetchOptions,
    clock: deps.clock,
  });
  if (checked.kind === "error") {
    return failed(options, `lookout-check:${checked.origin}:${checked.error.kind}: ${checked.error.message}`);
  }
  if (checked.kind === "unchanged-304" || checked.kind === "unchanged-hash") {
    const snapshotRef = checked.kind === "unchanged-304" ? checked.snapshotRef : checked.currentSnapshotRef;
    const persisted = observationStore ? await observationStore.loadLatest(source.id) : null;
    let baselineResult: TraverseRecrawlResult | null = null;
    if (persisted && !persisted.ok) return failed(options, `lookout-baseline:${persisted.error.kind}: ${persisted.error.message}`);
    if (!persisted || persisted.value === null) {
      // CHECK can be unchanged on first enablement because Traverse already has
      // a production snapshot corpus. Replay that exact classified snapshot to
      // seed Lookout's observation baseline without reviewer-visible events.
      const baseline = await replayCamp({ ...options, requiresRender: false, mode: "replay", fetchOptions: undefined });
      baselineResult = baseline;
      if (!baseline.ok) return failed(options, `lookout-baseline:${baseline.error}`);
      if (baseline.snapshot.ref !== snapshotRef) return failed(options, `lookout-baseline:snapshot-mismatch: classified ${snapshotRef}, replayed ${baseline.snapshot.ref ?? "none"}`);
      const selection = selectedKnownCampProposals(baseline, options);
      if (!selection.ok) return failed(options, `lookout-baseline:${selection.error}`);
      const proposals = selection.proposals;
      const emission = await emitCampfitObservation({
        source, entityKey: options.campId, checkedAt: checked.checkedAt,
        resultKind: "unchanged-hash", proposals,
        observation: { sourceId: source.id, snapshotRef, observedAt: checked.checkedAt, proposals },
        store: observationStore, spoolRoot: deps.surveySpoolRoot, now: deps.clock, faults: deps.emissionFaults,
      });
      if (!emission.ok) return failed(options, `lookout-baseline:${emission.error.kind}: ${emission.error.message}`);
      if (emission.value.events.length !== 0 || emission.value.surveyInput !== null) return failed(options, "lookout-baseline:unexpected-events");
    }
    // A zero-event baseline does not mean zero review proposals. On first
    // enablement the replay result is the DB-current projection and must flow
    // to the normal review sink (for example snapshot Boulder vs DB Denver).
    if (baselineResult) {
      const hasReviewChanges = Object.keys(baselineResult.proposedChanges).length > 0;
      return {
        ...baselineResult,
        ...(hasReviewChanges ? { unchangedFreshness: true } : { notModified: true }),
        warnings: [...checked.warnings, ...baselineResult.warnings, `lookout:${checked.kind}`],
      };
    }
    return { ...failed(options, ""), ok: true, notModified: true, error: null, snapshot: { ref: snapshotRef, bodyHash: null }, warnings: [...checked.warnings, `lookout:${checked.kind}`] };
  }
  // The plain extraction classifies shell content only; it cannot render on
  // its own. A shell warning triggers one separately Lookout-classified render.
  let replayed = await replayCamp({ ...options, requiresRender: false, mode: "replay", fetchOptions: undefined });
  if (replayed.snapshot.ref !== checked.currentSnapshotRef) {
    return failed(options, `lookout-check:snapshot-mismatch: classified ${checked.currentSnapshotRef}, replayed ${replayed.snapshot.ref ?? "none"}`);
  }
  const shellWarning = replayed.warnings.some((warning) => warning.startsWith("js-shell-suspected:"));
  if (policy === "on-shell-warning" && shellWarning && options.fetchOptions?.renderImpl) {
    checked = await runLookoutCheck({ ...source, renderPolicy: "always" }, {
      store: options.store,
      fetchSource: deps.fetchSource ?? traverseFetchSource,
      fetchOptions: options.fetchOptions,
      clock: deps.clock,
    });
    if (checked.kind !== "changed") {
      return failed(options, checked.kind === "error"
        ? `lookout-check:${checked.origin}:${checked.error.kind}: ${checked.error.message}`
        : `lookout-check:render-retry-${checked.kind}`);
    }
    replayed = await replayCamp({ ...options, requiresRender: false, mode: "replay", fetchOptions: undefined });
    if (replayed.snapshot.ref !== checked.currentSnapshotRef) {
      return failed(options, `lookout-check:snapshot-mismatch: classified ${checked.currentSnapshotRef}, replayed ${replayed.snapshot.ref ?? "none"}`);
    }
  }
  if (!replayed.ok) return replayed;

  const selection = selectedKnownCampProposals(replayed, options);
  if (!selection.ok) return failed(options, `lookout-emission:${selection.error}`);
  const proposals = selection.proposals;
  const observation: ProposalSetObservation = {
    sourceId: source.id,
    snapshotRef: checked.currentSnapshotRef,
    observedAt: checked.checkedAt,
    proposals,
  };
  const emission = await emitCampfitObservation({
    source, observation, checkedAt: checked.checkedAt, proposals,
    entityKey: options.campId, store: observationStore,
    spoolRoot: deps.surveySpoolRoot, now: deps.clock, faults: deps.emissionFaults,
  });
  if (!emission.ok) return failed(options, `lookout-emission:${emission.error.kind}: ${emission.error.message}`);
  // First enablement is an explicit native baseline: Lookout commits the
  // observation and returns baseline-established with no events/survey batch.
  return { ...replayed, warnings: [...checked.warnings, ...replayed.warnings] };
}

/**
 * Do not turn an arbitrary proposal bag into the known camp's observation.
 * Traverse must have proved one selected entity and must preserve that
 * entity's item index on every proposal. This remains safe on shared listing
 * pages: itemCount may exceed one, but exactly one itemIndex was selected.
 */
function selectedKnownCampProposals(
  replayed: TraverseRecrawlResult,
  options: TraverseRecrawlOptions,
): { ok: true; proposals: ExtractionProposal[] } | { ok: false; error: string } {
  const raw = replayed.rawExtraction;
  const itemIndex = raw.itemIndex;
  const itemName = raw.itemName;
  const proposals = raw.proposals;
  if (!Number.isInteger(itemIndex) || typeof itemName !== "string" || replayed.matchedItemName !== itemName) {
    return { ok: false, error: "unproven-known-camp-identity" };
  }
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return { ok: false, error: "zero-known-camp-entities" };
  }
  const indices = new Set<number>();
  for (const candidate of proposals) {
    if (!candidate || typeof candidate !== "object") return { ok: false, error: "invalid-known-camp-proposal" };
    const proposal = candidate as ExtractionProposal;
    const proposalIndex = proposal.pathIndices?.[0];
    // `allProposals` is already the selected assembled item. Some single-item
    // providers omit pathIndices; when present, indices are an additional
    // consistency guard and must all agree with Traverse's selected itemIndex.
    if (proposalIndex !== undefined) {
      if (!Number.isInteger(proposalIndex)) return { ok: false, error: "unproven-known-camp-identity" };
      indices.add(proposalIndex as number);
    }
  }
  if (indices.size > 1 || (indices.size === 1 && !indices.has(itemIndex as number))) {
    return { ok: false, error: "multiple-known-camp-entities" };
  }
  // campId is the durable Survey identity; Traverse's selected item evidence
  // proves which page entity supplies its claims without adopting a new ID.
  if (!options.campId) return { ok: false, error: "unproven-known-camp-identity" };
  return { ok: true, proposals: proposals as ExtractionProposal[] };
}

function failed(options: TraverseRecrawlOptions, error: string): TraverseRecrawlResult {
  return {
    ok: false, error, proposedChanges: {}, overallConfidence: 0,
    model: `traverse:${options.provider.name}`, rawExtraction: { via: "lookout-check", campId: options.campId, error },
    matchedItemName: null, itemCount: 0, snapshot: { ref: null, bodyHash: null },
    tokensUsed: null, providerCalls: 0, latencyMs: 0, warnings: [],
  };
}
