import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { SurveyInput } from "@kontourai/survey";
import { createDriftEmitter, createObservationStore, diffProposalSets, type LookoutSource, type ObservationStore, type ProposalSetObservation, type StoredProposalObservationV1 } from "@kontourai/lookout";
import { authorDriftSurveyInput } from "./lookout-survey-authoring";
import type { ExtractionProposal } from "@kontourai/traverse";

export const LOOKOUT_OBSERVATION_ROOT = path.join(process.cwd(), ".kontourai", "campfit", "lookout-observations");
export const LOOKOUT_SURVEY_SPOOL_ROOT = path.join(process.cwd(), ".kontourai", "campfit", "survey");

export function createCampfitObservationStore(root = LOOKOUT_OBSERVATION_ROOT) {
  return createObservationStore({ root });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Atomic, content-addressed spool. Existing identical delivery is success. */
export async function persistSurveyInput(input: SurveyInput, root = LOOKOUT_SURVEY_SPOOL_ROOT): Promise<{ path: string; duplicate: boolean }> {
  const body = `${stableJson(input)}\n`;
  const id = createHash("sha256").update(body).digest("hex");
  await mkdir(root, { recursive: true });
  const destination = path.join(root, `${id}.json`);
  const temporary = path.join(root, `.${id}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // link is atomic and, unlike POSIX rename, never replaces an existing
      // idempotency key. The temp inode is removed after publication.
      await link(temporary, destination);
      await unlink(temporary);
      return { path: destination, duplicate: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlink(temporary).catch(() => undefined);
      return { path: destination, duplicate: true };
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

interface PendingSurvey {
  sourceId: string;
  snapshotRef: string;
  survey: SurveyInput;
}

async function stageSurvey(input: PendingSurvey, root: string): Promise<string> {
  const body = `${stableJson(input)}\n`;
  const id = createHash("sha256").update(body).digest("hex");
  const pendingRoot = path.join(root, ".pending");
  await mkdir(pendingRoot, { recursive: true });
  const destination = path.join(pendingRoot, `${id}.json`);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { await unlink(temporary).catch(() => undefined); }
  return destination;
}

async function finalizePending(pendingPath: string, root: string): Promise<void> {
  const pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingSurvey;
  await persistSurveyInput(pending.survey, root);
  await unlink(pendingPath);
}

/** Recover a commit that advanced its observation pointer before publication. */
export async function recoverPendingSurveyDelivery(sourceId: string, store: ObservationStore, root = LOOKOUT_SURVEY_SPOOL_ROOT): Promise<void> {
  const pendingRoot = path.join(root, ".pending");
  const names = await readdir(pendingRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (names.length === 0) return;
  const latest = await store.loadLatest(sourceId);
  if (!latest.ok) throw new Error(latest.error.message);
  for (const name of names) {
    const pendingPath = path.join(pendingRoot, name);
    const pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingSurvey;
    if (pending.sourceId !== sourceId) continue;
    if (latest.value?.snapshotRef === pending.snapshotRef) await finalizePending(pendingPath, root);
    else await unlink(pendingPath); // commit did not advance; retry will author it again
  }
}

/**
 * Emit through Lookout's native observation diff. The wrapped commit enforces
 * survey-before-observation ordering: a spool failure prevents the observation
 * pointer advancing, so retry can neither lose the event nor duplicate a batch.
 */
export async function emitCampfitObservation(input: {
  source: LookoutSource;
  observation: ProposalSetObservation;
  checkedAt: string;
  resultKind?: "changed" | "unchanged-hash";
  proposals: readonly ExtractionProposal[];
  entityKey: string;
  store?: ObservationStore;
  spoolRoot?: string;
  now?: () => string;
  faults?: { beforeObservationCommit?: () => void; beforeSurveyFinalize?: () => void };
}) {
  const delegate = input.store ?? createCampfitObservationStore();
  const spoolRoot = input.spoolRoot ?? LOOKOUT_SURVEY_SPOOL_ROOT;
  try { await recoverPendingSurveyDelivery(input.source.id, delegate, spoolRoot); } catch (cause) {
    return { ok: false as const, error: { kind: "persistence-error" as const, message: "Could not recover pending Survey delivery", cause } };
  }
  let authored: SurveyInput | null = null;
  let pendingPath: string | null = null;
  // Lookout 0.3.x emits neutral drift and no longer authors the trust record,
  // so the pieces it used to hold internally are captured here instead: the
  // prior observation as it is loaded, and the events as they are diffed.
  // Both are needed before commit, because commit stages the survey first.
  let prior: StoredProposalObservationV1 | null = null;
  const nowFn = input.now ?? (() => new Date().toISOString());
  // Read once and reused for the observation record and the authored record, as
  // Lookout did. Calling a real clock twice would let them disagree.
  const recordedAt = nowFn();
  const orderedStore: ObservationStore = {
    loadLatest: async (sourceId) => {
      const loaded = await delegate.loadLatest(sourceId);
      if (loaded.ok) prior = loaded.value;
      return loaded;
    },
    commit: async (record, expectedPriorId) => {
      if (authored) pendingPath = await stageSurvey({ sourceId: input.source.id, snapshotRef: input.observation.snapshotRef, survey: authored }, spoolRoot);
      input.faults?.beforeObservationCommit?.();
      const committed = await delegate.commit(record, expectedPriorId);
      if (!committed.ok) {
        if (pendingPath) await unlink(pendingPath).catch(() => undefined);
        return committed;
      }
      if (pendingPath) {
        input.faults?.beforeSurveyFinalize?.();
        await finalizePending(pendingPath, spoolRoot);
      }
      return committed;
    },
  };
  const emitter = createDriftEmitter<readonly ExtractionProposal[]>({
    store: orderedStore,
    now: () => recordedAt,
    diff: (diffInput) => {
      const result = diffProposalSets(diffInput);
      // Authored here rather than after emit(): the ordered commit stages the
      // survey before the observation pointer advances, and that ordering is
      // what makes a retry unable to lose the event or duplicate a batch.
      if (result.ok && prior) {
        authored = authorDriftSurveyInput({
          source: input.source,
          prior: { observationId: prior.observationId, snapshotRef: prior.snapshotRef },
          current: { snapshotRef: input.observation.snapshotRef, observedAt: input.observation.observedAt },
          events: result.value.events,
          generatedAt: recordedAt,
          transform: (survey) => ({
            ...survey,
            claims: survey.claims.map((claim) => ({ ...claim, subjectType: "campfit.camp", subjectId: input.entityKey })),
          }) as SurveyInput,
        });
      }
      return result;
    },
  });
  const emitted = await emitter.emit({
    source: input.source,
    current: input.observation,
    check: { checkedAt: input.checkedAt, resultKind: input.resultKind ?? "changed", currentSnapshotRef: input.observation.snapshotRef },
    callbacks: {
      selectEntities: (observation) => [observation.proposals],
      entityIdentity: () => input.entityKey,
      proposalsFor: (proposals) => proposals,
      fieldIdentity: (_proposals, proposal) => proposal.fieldPath.replace(/^items\[\]\./, ""),
    },
  });
  // Lookout's own result no longer carries the trust record. Callers here still
  // read `surveyInput` — including the baseline assertion that a first
  // enablement authors none — so it is restored from what this module authored.
  return emitted.ok ? { ...emitted, value: { ...emitted.value, surveyInput: authored } } : emitted;
}
