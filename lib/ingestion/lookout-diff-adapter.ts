import {
  compareStructural,
  diffKeyedMultiset,
  type DiffKernelError,
  type DiffResult,
  type IdentityResult,
} from "@kontourai/lookout";

import { conservativeReviewError } from "./diff-policy";

export interface ValueChange {
  readonly old: unknown;
  readonly new: unknown;
}

export interface ValueDiff {
  readonly changed: boolean;
  readonly change: ValueChange | null;
  readonly error?: DiffKernelError;
}

export interface RelationDiff {
  readonly changed: boolean;
  readonly unchanged: boolean;
  readonly allCurrentRetained: boolean;
  readonly hasNovelCandidate: boolean;
  readonly additions: readonly unknown[];
  readonly removals: readonly unknown[];
  readonly change: ValueChange | null;
  readonly error?: DiffKernelError;
}

export function compareValue(
  oldValue: unknown,
  newValue: unknown,
  project: (value: unknown) => unknown = (value) => value,
): ValueDiff {
  const result = compareStructural(oldValue, newValue, { value: project });
  if (!result.ok) {
    const review = conservativeReviewError(result.error);
    return { changed: review.changed, change: { old: oldValue, new: newValue }, error: review.error };
  }
  const changed = result.value.valueChanged;
  return { changed, change: changed ? { old: oldValue, new: newValue } : null };
}

export function compareRelation(
  currentItems: readonly unknown[],
  candidateItems: readonly unknown[],
  identity: (value: unknown) => string | IdentityResult<string>,
): RelationDiff {
  type KeyedItem = { readonly value: unknown; readonly key: string };
  const resolve = (value: unknown): DiffResult<KeyedItem> => {
    try {
      const resolved = identity(value);
      if (typeof resolved === "string") return { ok: true, value: { value, key: resolved } };
      return resolved.ok
        ? { ok: true, value: { value, key: resolved.key } }
        : resolved;
    } catch (cause) {
      return {
        ok: false,
        error: { kind: "callback-threw", message: "identity callback threw", cause },
      };
    }
  };
  const currentKeyed: KeyedItem[] = [];
  const candidateKeyed: KeyedItem[] = [];
  for (const value of currentItems) {
    const keyed = resolve(value);
    if (!keyed.ok) return relationError(currentItems, candidateItems, keyed.error);
    currentKeyed.push(keyed.value);
  }
  for (const value of candidateItems) {
    const keyed = resolve(value);
    if (!keyed.ok) return relationError(currentItems, candidateItems, keyed.error);
    candidateKeyed.push(keyed.value);
  }

  const result: DiffResult<{
    readonly unchanged: boolean;
    readonly additions: readonly KeyedItem[];
    readonly removals: readonly KeyedItem[];
  }> = diffKeyedMultiset(currentKeyed, candidateKeyed, { identity: (item) => item.key });

  if (!result.ok) {
    return relationError(currentItems, candidateItems, result.error);
  }

  const { unchanged, additions, removals } = result.value;
  const currentKeys = new Set(currentKeyed.map((item) => item.key));
  return {
    changed: !unchanged,
    unchanged,
    allCurrentRetained: removals.length === 0,
    hasNovelCandidate: additions.some((item) => !currentKeys.has(item.key)),
    additions: additions.map((item) => item.value),
    removals: removals.map((item) => item.value),
    change: unchanged ? null : { old: currentItems, new: candidateItems },
  };
}

function relationError(
  currentItems: readonly unknown[],
  candidateItems: readonly unknown[],
  error: DiffKernelError,
): RelationDiff {
  const review = conservativeReviewError(error);
  return {
    changed: review.changed,
    unchanged: false,
    allCurrentRetained: false,
    hasNovelCandidate: true,
    additions: [],
    removals: [],
    change: { old: currentItems, new: candidateItems },
    error: review.error,
  };
}
