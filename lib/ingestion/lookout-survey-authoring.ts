/**
 * Authors the Survey input for a Lookout drift round.
 *
 * Lookout 0.3.0 removed `createSurveyEmitter` and with it the `surveyInput`
 * field on the result: it emits neutral drift and leaves trust records to the
 * consumer (lookout#15). This module is the authoring Lookout used to do,
 * moved here unchanged, so the records CampFit publishes keep the identity
 * they had before the cutover.
 *
 * That identity is load-bearing rather than cosmetic. `docs/lookout-cutover.md`
 * states that changing a source ID starts a new validator, snapshot and
 * observation lineage and is therefore prohibited; the same reasoning applies
 * to the observation IDs derived here, which are a hash over the source, the
 * prior observation, the current snapshot and the event. A silently different
 * hash would fork the lineage of every existing source without failing
 * anything, so `tests/fixtures/lookout-survey-authoring-golden.json` pins the
 * output byte-for-byte against records produced by lookout@0.2.0.
 */
import { createHash } from "node:crypto";
import { SurveyInputBuilder } from "@kontourai/survey";
import type { SurveyInput } from "@kontourai/survey";
import type { LookoutSource, ProposalDiffEvent } from "@kontourai/lookout";

/** The prior observation a drift round was diffed against. */
export interface PriorObservationAnchor {
  readonly observationId: string;
  readonly snapshotRef: string;
}

/** The observation the round produced. */
export interface CurrentObservationAnchor {
  readonly snapshotRef: string;
  readonly observedAt: string;
}

function id(...parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function eventValue(event: ProposalDiffEvent): unknown {
  return event.kind === "new-entity-appeared"
    ? { kind: event.kind, entityKey: event.entityKey, currentValues: event.current.map((item) => ({ fieldKey: item.fieldKey, value: item.value })) }
    : {
        kind: event.kind,
        changeKind: event.changeKind,
        entityKey: event.entityKey,
        fieldKey: event.fieldKey,
        ...(event.prior ? { priorValue: event.prior.value } : {}),
        ...(event.current ? { currentValue: event.current.value } : {}),
      };
}

/**
 * Survey's `RawSourceKind` has no `structured-file`, which is a valid Lookout
 * source kind. Lookout authored this in untyped JavaScript and passed the value
 * straight through, so such a source would have produced a record naming a kind
 * Survey does not define — silently, because nothing on that path was typed.
 *
 * CampFit only registers `web-page` sources today, so this refuses rather than
 * inventing a mapping: an unmappable kind is a decision to make deliberately,
 * not one to guess at while porting.
 */
function rawSourceKindFor(kind: LookoutSource["kind"]): "web-page" | "api-record" {
  if (kind === "web-page" || kind === "api-record") return kind;
  throw new Error(`lookout-survey-authoring:unmappable-source-kind:${kind}`);
}

function observationFor(
  source: LookoutSource,
  prior: PriorObservationAnchor,
  current: CurrentObservationAnchor,
  event: ProposalDiffEvent,
  generatedAt: string,
  index: number,
) {
  const eventId = id(
    source.id,
    prior.observationId,
    current.snapshotRef,
    event.kind,
    event.entityKey,
    event.kind === "field-changed" ? event.fieldKey : "",
    index,
  );
  const evidence = event.kind === "new-entity-appeared"
    ? event.current
    : [event.prior, event.current].filter((item): item is NonNullable<typeof item> => item !== undefined);
  const primary = event.kind === "new-entity-appeared" ? event.current[0] : event.current ?? event.prior;
  const metadata = {
    sourceId: source.id,
    eventKind: event.kind,
    priorObservationId: prior.observationId,
    priorSnapshotRef: prior.snapshotRef,
    currentSnapshotRef: current.snapshotRef,
    evidence: evidence.map((item) => ({
      snapshotRef: item.snapshotRef,
      locator: item.provenance.locator,
      excerpt: item.provenance.excerpt,
      extractor: item.extractor,
      fieldPath: item.fieldPath,
    })),
    ...(event.kind === "field-changed" ? { changeKind: event.changeKind } : {}),
  };
  return {
    id: `lookout-${eventId}`,
    rawSource: {
      kind: rawSourceKindFor(source.kind),
      resolution: "observation" as const,
      sourceRef: current.snapshotRef,
      observedAt: current.observedAt,
      locatorScheme: (source.kind === "web-page" ? "html" : "structured-field") as "html" | "structured-field",
      metadata,
    },
    extraction: {
      target: `lookout:${event.entityKey}:${event.kind === "field-changed" ? event.fieldKey : "appearance"}`,
      value: eventValue(event),
      confidence: primary?.confidence,
      locator: primary?.provenance.locator,
      excerpt: primary?.provenance.excerpt,
      extractor: primary?.extractor ?? "lookout:proposal-diff",
      extractedAt: generatedAt,
      metadata,
    },
    candidateSet: { status: "needs-review" as const, metadata },
    claim: {
      subjectType: "lookout.observed-entity" as const,
      subjectId: event.entityKey,
      facet: "lookout.source-change",
      claimType: event.kind === "new-entity-appeared" ? "lookout.new-entity-appeared" : "lookout.field-changed",
      fieldOrBehavior: event.kind === "field-changed" ? event.fieldKey : event.entityKey,
      value: eventValue(event),
      status: "proposed" as const,
      impactLevel: "low" as const,
      collectedBy: "@kontourai/lookout",
      createdAt: generatedAt,
      evidenceMethod: "observation" as const,
      metadata,
    },
  };
}

function containsAuthorizing(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAuthorizing);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => key === "authorizing" || containsAuthorizing(item));
}

/**
 * Refuses a record that claims more than an observation can support.
 *
 * Ported alongside the authoring because it is the half that made the authoring
 * safe: Lookout validated its own output before returning it, and dropping the
 * check while keeping the builder would have moved the authoring here without
 * the guarantee that made it trustworthy.
 */
export function isObservationOnly(input: SurveyInput, eventCount: number): boolean {
  if (input.reviewOutcomes.length !== 0 || containsAuthorizing(input)) return false;
  return input.rawSources.length === eventCount && input.claims.length === eventCount;
}

/**
 * The record Lookout would have authored for these events, or `null` when a
 * round produced none — a baseline observation, or a check that found no drift.
 */
export function authorDriftSurveyInput(options: {
  readonly source: LookoutSource;
  readonly prior: PriorObservationAnchor;
  readonly current: CurrentObservationAnchor;
  readonly events: readonly ProposalDiffEvent[];
  readonly generatedAt: string;
  /** Applied before validation, exactly where Lookout applied it. */
  readonly transform?: (input: SurveyInput) => SurveyInput;
}): SurveyInput | null {
  const { source, prior, current, events, generatedAt, transform } = options;
  if (events.length === 0) return null;
  const builder = new SurveyInputBuilder({ source: "@kontourai/lookout", generatedAt });
  builder.addObservations(events.map((event, index) => observationFor(source, prior, current, event, generatedAt, index)));
  let authored = builder.build();
  if (transform) authored = transform(authored);
  JSON.stringify(authored);
  if (!isObservationOnly(authored, events.length)) {
    throw new Error("lookout-survey-authoring:observation-only-violation");
  }
  return authored;
}
