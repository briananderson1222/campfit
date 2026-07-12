import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { SurveyInput } from "@kontourai/survey";
import { createObservationStore, createSurveyEmitter, type LookoutSource, type ObservationStore, type ProposalSetObservation } from "@kontourai/lookout";
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
async function recoverPending(sourceId: string, store: ObservationStore, root: string): Promise<void> {
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
  try { await recoverPending(input.source.id, delegate, spoolRoot); } catch (cause) {
    return { ok: false as const, error: { kind: "persistence-error" as const, message: "Could not recover pending Survey delivery", cause } };
  }
  let authored: SurveyInput | null = null;
  let pendingPath: string | null = null;
  const orderedStore: ObservationStore = {
    loadLatest: (sourceId) => delegate.loadLatest(sourceId),
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
  const emitter = createSurveyEmitter<readonly ExtractionProposal[]>({
    store: orderedStore,
    now: input.now,
    transformSurveyInput: (survey) => {
      const mapped = {
        ...survey,
        claims: survey.claims.map((claim) => ({ ...claim, subjectType: "campfit.camp", subjectId: input.entityKey })),
      } as SurveyInput;
      authored = mapped;
      return mapped;
    },
  });
  return emitter.emit({
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
}
