import type { ExtractionProposal, ExtractionProvider } from "@kontourai/traverse";
import type { SurveyInput } from "@kontourai/survey";
import type { FetchSourceOptions, SnapshotStore } from "@kontourai/traverse/fetch";
import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createSurveyEmitter, diffProposalSets, extractionProposalIdentity } from "@kontourai/lookout";
import type { FetchSource, LookoutSource, NewEntityAppearedEvent, ProposalDiffEvent } from "@kontourai/lookout";
import { groupDiscoveryItems } from "./discovery-item-grouping";
import {
  buildDiscoveryFieldSources,
  type DiscoveredCampStub,
  type DiscoveryObservation,
} from "./llm-discovery";
import { discoverCampsFromUrl } from "./llm-discovery";
import { runLookoutCheck } from "./lookout-check-adapter";
import { createCampfitObservationStore, persistSurveyInput } from "./lookout-observation-store";
import { assignGlobalItemIndices } from "./traverse-item-grouping";

export { DISCOVERY_SOURCE_PREFIX, discoverySourceId, listingToLookoutSource } from "./lookout-sources";
import { discoverySourceId, listingToLookoutSource } from "./lookout-sources";

function eventProposal(evidence: NewEntityAppearedEvent["current"][number]): ExtractionProposal {
  return {
    fieldPath: evidence.fieldPath,
    candidateValue: evidence.value,
    confidence: evidence.confidence,
    provenance: evidence.provenance,
    extractor: evidence.extractor,
    ...(evidence.pathIndices ? { pathIndices: [...evidence.pathIndices] } : {}),
  };
}

/**
 * Converts only a genuine Lookout new-entity event into C2's validated shape.
 * The event must resolve to exactly one grouped item and to the expected stable
 * listing lineage; ambiguity and incomplete provenance fail closed.
 */
export function discoveryEventToStub(
  event: ProposalDiffEvent,
  sourceUrl: string,
): DiscoveredCampStub | null {
  if (event.kind !== "new-entity-appeared" || event.current.length === 0) return null;
  const sourceId = discoverySourceId(sourceUrl);
  if (event.current.some((item) => item.sourceId !== sourceId)) return null;
  const snapshotRefs = new Set(event.current.map((item) => item.snapshotRef));
  if (snapshotRefs.size !== 1) return null;

  const grouped = groupDiscoveryItems(event.current.map(eventProposal), sourceUrl);
  if (grouped.items.length !== 1) return null;
  const stub = { ...grouped.items[0], sourceUrl, sourceRef: event.current[0].snapshotRef };
  // This is deliberately a validation step, not merely a later insert helper:
  // no event can reach a persistence callback with unresolved evidence.
  buildDiscoveryFieldSources(stub);
  return stub;
}

export interface DiscoveryPlaceholderInsert {
  stub: DiscoveredCampStub;
  fieldSources: Record<string, DiscoveryObservation>;
}

export interface DiscoveryPlaceholderRepository {
  /**
   * Transactional seam: re-read canonical Camp names, apply C2's 0.75 Dice
   * dedupe, and insert a PLACEHOLDER with provider/community association only
   * when still new. Duplicate delivery returns false.
   */
  insertIfNew(input: DiscoveryPlaceholderInsert): Promise<boolean>;
  /**
   * Durable boundary for a listing observation. Implementations commit the
   * idempotent database transaction before advancing the observation. If the
   * observation commit fails, redelivery safely no-ops in the database and
   * retries the observation advancement.
   */
  recordObservationAndInsert?(
    inputs: readonly DiscoveryPlaceholderInsert[],
    commitObservation: () => Promise<void>,
  ): Promise<{ inserted: number; ignored: number }>;
}

export async function persistDiscoveryEvents(
  events: readonly ProposalDiffEvent[],
  sourceUrl: string,
  repository: DiscoveryPlaceholderRepository,
): Promise<{ inserted: number; ignored: number }> {
  let inserted = 0;
  let ignored = 0;
  for (const event of events) {
    const stub = discoveryEventToStub(event, sourceUrl);
    if (!stub) {
      ignored++;
      continue;
    }
    const fieldSources = buildDiscoveryFieldSources(stub);
    if (await repository.insertIfNew({ stub, fieldSources })) inserted++;
    else ignored++;
  }
  return { inserted, ignored };
}

function discoveryEventInputs(events: readonly ProposalDiffEvent[], sourceUrl: string) {
  const inputs: DiscoveryPlaceholderInsert[] = [];
  let ignored = 0;
  for (const event of events) {
    const stub = discoveryEventToStub(event, sourceUrl);
    if (!stub) { ignored++; continue; }
    inputs.push({ stub, fieldSources: buildDiscoveryFieldSources(stub) });
  }
  return { inputs, ignored };
}

interface ProposalEntity { name: string; proposals: ExtractionProposal[] }

function proposalEntities(observation: { proposals: readonly ExtractionProposal[] }): ProposalEntity[] {
  const groups = new Map<number, ExtractionProposal[]>();
  for (const item of assignGlobalItemIndices([...observation.proposals]).items) {
    groups.set(item.globalIndex, [...(groups.get(item.globalIndex) ?? []), item.proposal]);
  }
  return [...groups.values()].map((proposals) => ({
    proposals,
    name: String(proposals.find((proposal) => proposal.fieldPath === "items[].name")?.candidateValue ?? "").trim(),
  })).filter((entity) => entity.name.length > 0);
}

export interface RunLookoutListingOptions {
  provider: ExtractionProvider;
  store: SnapshotStore;
  repository: DiscoveryPlaceholderRepository;
  fetchSource?: FetchSource;
  fetchOptions?: FetchSourceOptions;
  requiresRender?: boolean;
  observationStore?: ReturnType<typeof createCampfitObservationStore>;
  surveyRoot?: string;
  pendingRoot?: string;
}

const defaultListingObservationStore = createCampfitObservationStore();
const DEFAULT_LISTING_PENDING_ROOT = path.join(process.cwd(), ".kontourai", "campfit", "listing-pending");

interface PendingListingDelivery {
  sourceId: string;
  snapshotRef: string;
  record: Parameters<ReturnType<typeof createCampfitObservationStore>["commit"]>[0];
  expectedPriorId: string | null;
  survey: SurveyInput | null;
  inputs: DiscoveryPlaceholderInsert[];
  ignored: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

async function stageListingDelivery(delivery: PendingListingDelivery, root: string): Promise<string> {
  const body = `${stableJson(delivery)}\n`;
  const id = createHash("sha256").update(`${delivery.sourceId}\0${delivery.snapshotRef}`).digest("hex");
  await mkdir(root, { recursive: true });
  const destination = path.join(root, `${id}.json`);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return destination;
}

async function finishListingDelivery(
  delivery: PendingListingDelivery,
  repository: DiscoveryPlaceholderRepository,
  observationStore: ReturnType<typeof createCampfitObservationStore>,
  surveyRoot: string | undefined,
): Promise<{ inserted: number; ignored: number }> {
  let observationResult: Awaited<ReturnType<typeof observationStore.commit>> | undefined;
  const commitObservation = async () => {
    if (delivery.survey) await persistSurveyInput(delivery.survey, surveyRoot);
    observationResult = await observationStore.commit(delivery.record, delivery.expectedPriorId);
    if (!observationResult.ok) throw new Error(`lookout-listing:observation-${observationResult.error.kind}: ${observationResult.error.message}`);
  };
  const persisted = repository.recordObservationAndInsert
    ? await repository.recordObservationAndInsert(delivery.inputs, commitObservation)
    : await (async () => {
      let inserted = 0;
      let ignored = 0;
      for (const input of delivery.inputs) (await repository.insertIfNew(input)) ? inserted++ : ignored++;
      await commitObservation();
      return { inserted, ignored };
    })();
  if (!observationResult?.ok) throw new Error("lookout-listing:observation-callback-not-invoked");
  return { inserted: persisted.inserted, ignored: persisted.ignored + delivery.ignored };
}

async function reconcileListingDeliveries(
  sourceId: string,
  root: string,
  repository: DiscoveryPlaceholderRepository,
  observationStore: ReturnType<typeof createCampfitObservationStore>,
  surveyRoot: string | undefined,
): Promise<{ inserted: number; ignored: number }> {
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  let aggregate = { inserted: 0, ignored: 0 };
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pendingPath = path.join(root, name);
    const delivery = JSON.parse(await readFile(pendingPath, "utf8")) as PendingListingDelivery;
    if (delivery.sourceId !== sourceId) continue;
    const latest = await observationStore.loadLatest(sourceId);
    if (!latest.ok) throw new Error(`lookout-listing:pending-load: ${latest.error.message}`);
    if (latest.value?.snapshotRef === delivery.snapshotRef) {
      // The observation commit succeeded and only pending cleanup was
      // interrupted. Survey publication is content-addressed, so finalizing it
      // again is safe; database effects must not be repeated.
      if (delivery.survey) await persistSurveyInput(delivery.survey, surveyRoot);
      await unlink(pendingPath);
      continue;
    }
    const result = await finishListingDelivery(delivery, repository, observationStore, surveyRoot);
    aggregate = { inserted: aggregate.inserted + result.inserted, ignored: aggregate.ignored + result.ignored };
    await unlink(pendingPath);
  }
  return aggregate;
}

/** CHECK, replay extraction, baseline/event emission, durable Survey spool, and C2 insertion. */
export async function runLookoutListingDiscovery(url: string, options: RunLookoutListingOptions) {
  const source = listingToLookoutSource(url, { renderPolicy: options.requiresRender ? "always" : "on-shell-warning" });
  const observationStore = options.observationStore ?? defaultListingObservationStore;
  const pendingRoot = options.pendingRoot ?? DEFAULT_LISTING_PENDING_ROOT;
  const recovered = await reconcileListingDeliveries(source.id, pendingRoot, options.repository, observationStore, options.surveyRoot);
  let checked = await runLookoutCheck(source, {
    store: options.store,
    fetchSource: options.fetchSource ?? (await import("@kontourai/traverse/fetch")).fetchSource,
    fetchOptions: options.fetchOptions,
  });
  if (checked.kind === "error") throw new Error(`lookout-listing:${checked.origin}:${checked.error.kind}: ${checked.error.message}`);
  const unchangedEnablement = checked.kind === "unchanged-304" || checked.kind === "unchanged-hash";
  if (unchangedEnablement) {
    const latestObservation = await observationStore.loadLatest(source.id);
    if (!latestObservation.ok) throw new Error(`lookout-listing:observation-${latestObservation.error.kind}: ${latestObservation.error.message}`);
    if (latestObservation.value) return { ...recovered, unchanged: true, baseline: false };
  }

  // On first enablement an existing Traverse snapshot may classify unchanged.
  // Replay that exact classified snapshot to seed Lookout's listing baseline;
  // native first-observation semantics guarantee zero events/inserts/survey.
  let snapshotRef = checked.kind === "unchanged-304" ? checked.snapshotRef : checked.currentSnapshotRef;
  let discovery = await discoverCampsFromUrl(url, { provider: options.provider, store: options.store, mode: "replay" });
  if (discovery.error || !discovery.proposals) throw new Error(discovery.error ?? "Lookout listing replay returned no proposals");
  if (discovery.sourceRef !== snapshotRef) {
    throw new Error(`lookout-listing:snapshot-mismatch: classified ${snapshotRef}, replayed ${discovery.sourceRef ?? "none"}`);
  }
  const shellWarning = discovery.warnings?.some((warning) => warning.startsWith("js-shell-suspected:")) ?? false;
  if (!unchangedEnablement && !options.requiresRender && shellWarning && options.fetchOptions?.renderImpl) {
    checked = await runLookoutCheck({ ...source, renderPolicy: "always" }, {
      store: options.store,
      fetchSource: options.fetchSource ?? (await import("@kontourai/traverse/fetch")).fetchSource,
      fetchOptions: options.fetchOptions,
    });
    if (checked.kind !== "changed") throw new Error(`lookout-listing:render-retry-${checked.kind}`);
    snapshotRef = checked.currentSnapshotRef;
    discovery = await discoverCampsFromUrl(url, { provider: options.provider, store: options.store, mode: "replay" });
    if (discovery.error || !discovery.proposals) throw new Error(discovery.error ?? "Lookout listing rendered replay returned no proposals");
    if (discovery.sourceRef !== snapshotRef) throw new Error(`lookout-listing:snapshot-mismatch: classified ${snapshotRef}, replayed ${discovery.sourceRef ?? "none"}`);
  }

  let authored: SurveyInput | null = null;
  let derivedEvents: readonly ProposalDiffEvent[] = [];
  let persisted = { inserted: 0, ignored: 0 };
  const emitter = createSurveyEmitter<ProposalEntity>({
    store: {
      loadLatest: (sourceId) => observationStore.loadLatest(sourceId),
      commit: async (record, expectedPriorId) => {
        const { inputs, ignored } = discoveryEventInputs(derivedEvents, url);
        const delivery: PendingListingDelivery = { sourceId: source.id, snapshotRef, record, expectedPriorId, survey: authored, inputs, ignored };
        const pendingPath = await stageListingDelivery(delivery, pendingRoot);
        persisted = await finishListingDelivery(delivery, options.repository, observationStore, options.surveyRoot);
        await unlink(pendingPath);
        const committed = await observationStore.loadLatest(source.id);
        if (!committed.ok || !committed.value) throw new Error("lookout-listing:observation-commit-missing");
        return { ok: true as const, value: committed.value };
      },
    },
    diff: (input) => {
      const result = diffProposalSets(input);
      if (result.ok) derivedEvents = result.value.events;
      return result;
    },
    transformSurveyInput: (survey) => { authored = survey; return survey; },
  });
  const emitted = await emitter.emit({
    source,
    current: { sourceId: source.id, snapshotRef, observedAt: checked.checkedAt, proposals: discovery.proposals },
    check: { checkedAt: checked.checkedAt, resultKind: checked.kind === "changed" ? "changed" : "unchanged-hash", currentSnapshotRef: snapshotRef },
    callbacks: {
      selectEntities: proposalEntities,
      entityIdentity: (entity) => entity.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      proposalsFor: (entity) => entity.proposals,
      fieldIdentity: (_entity, proposal) => extractionProposalIdentity(proposal),
    },
  });
  if (!emitted.ok) throw new Error(`lookout-listing:${emitted.error.kind}: ${emitted.error.message}`);
  return { inserted: recovered.inserted + persisted.inserted, ignored: recovered.ignored + persisted.ignored, unchanged: unchangedEnablement, baseline: emitted.value.facts.some((fact) => fact.kind === "baseline-established") };
}
