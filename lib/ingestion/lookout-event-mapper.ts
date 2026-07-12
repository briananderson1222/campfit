import type { ProposalDiffEvent } from "@kontourai/lookout";
import type { Camp } from "@/lib/types";
import type { ProposedChanges } from "@/lib/admin/types";
import type { CampInput } from "./adapter";
import { computeDiff } from "./diff-engine";
import { CAMP_TARGET_SCHEMA } from "./traverse-schema";

const CAMP_EVENT_FIELDS = new Set(CAMP_TARGET_SCHEMA.map((field) => field.path.replace(/^items\[\]\./, "")));

export interface EventMapResult {
  changes: ProposedChanges;
  warnings: string[];
}

/**
 * Native event projection. This is useful for survey/replay reporting, but is
 * deliberately not the DB-current review authority (see dbCurrentProposedChanges).
 */
export function eventsToProposedChanges(
  events: readonly ProposalDiffEvent[],
  sourceUrl: string,
  allowedFields: ReadonlySet<string> = CAMP_EVENT_FIELDS,
): EventMapResult {
  const changes: ProposedChanges = {};
  const warnings: string[] = [];
  for (const event of events) {
    if (event.kind !== "field-changed") continue;
    if (!allowedFields.has(event.fieldKey)) {
      warnings.push(`unsupported-field-not-proposed:${event.entityKey}:${event.fieldKey}`);
      continue;
    }
    if (!event.current) {
      warnings.push(`removal-not-proposed:${event.entityKey}:${event.fieldKey}`);
      continue;
    }
    changes[event.fieldKey] = {
      old: event.prior?.value,
      new: event.current.value,
      confidence: event.current.confidence,
      mode: event.changeKind === "value-populated" ? "populate"
        : event.changeKind === "items-added" ? "add_items" : "update",
      excerpt: event.current.provenance.excerpt,
      sourceUrl,
    };
  }
  return { changes, warnings };
}

/**
 * Review authority for L4. Lookout 0.2.0 cannot inject a caller-owned prior
 * observation on a baseline, so canonical DB-current semantics compose through
 * the existing D1 kernel-backed diff route exactly once.
 */
export function dbCurrentProposedChanges(input: {
  current: Camp;
  extracted: Partial<CampInput>;
  confidence: Record<string, number>;
  excerpts?: Record<string, string>;
  fieldSources?: Record<string, { approvedAt?: string }>;
  sourceUrl: string;
}): ProposedChanges {
  return computeDiff(input.current, input.extracted, input.confidence, input.excerpts, input.fieldSources, input.sourceUrl);
}
