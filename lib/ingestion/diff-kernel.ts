/**
 * Pure comparison/provenance mechanics shared by CampFit's two proposal
 * paths. Field selection, confidence policy, suppression, and proposal modes
 * deliberately remain in their callers.
 */

export interface ValueChange {
  old: unknown;
  new: unknown;
}

export interface RelationFacts {
  allCurrentRetained: boolean;
  hasNovelCandidate: boolean;
}

export type CanonicalValueResult =
  | { ok: true; key: string }
  | { ok: false; error: { code: "cycle" | "unsupported"; message: string } };

export interface DomainIdentityError {
  code: "invalid-domain-value" | "canonicalization-failed";
  family: "ageGroups" | "schedules" | "pricing";
  field: string;
  message: string;
}

export type DomainIdentityResult =
  | { ok: true; key: string }
  | { ok: false; error: DomainIdentityError };

type RelationIdentity = (value: unknown) => string | DomainIdentityResult;

function segment(tag: string, value = ""): string {
  return `${tag}${value.length}:${value}`;
}

/** Local consumer-shaped precursor to the shared canonical-value adapter. */
export function canonicalValueKey(value: unknown): CanonicalValueResult {
  const ancestors = new Set<object>();

  const encode = (candidate: unknown): CanonicalValueResult => {
    if (candidate === undefined) return { ok: true, key: "u" };
    if (candidate === null) return { ok: true, key: "l" };
    if (typeof candidate === "string") return { ok: true, key: segment("s", candidate) };
    if (typeof candidate === "boolean") return { ok: true, key: candidate ? "b1" : "b0" };
    if (typeof candidate === "bigint") return { ok: true, key: segment("i", candidate.toString()) };
    if (typeof candidate === "number") {
      if (Number.isNaN(candidate)) return { ok: true, key: "n:NaN" };
      if (candidate === Number.POSITIVE_INFINITY) return { ok: true, key: "n:+Infinity" };
      if (candidate === Number.NEGATIVE_INFINITY) return { ok: true, key: "n:-Infinity" };
      if (Object.is(candidate, -0)) return { ok: true, key: "n:-0" };
      return { ok: true, key: segment("n", String(candidate)) };
    }
    if (typeof candidate !== "object") {
      return {
        ok: false,
        error: { code: "unsupported", message: `Unsupported canonical value: ${typeof candidate}` },
      };
    }

    if (ancestors.has(candidate)) {
      return { ok: false, error: { code: "cycle", message: "Cyclic canonical value" } };
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      return {
        ok: false,
        error: { code: "unsupported", message: "Only arrays and plain objects are canonical values" },
      };
    }

    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        let encoded = "";
        for (let index = 0; index < candidate.length; index += 1) {
          if (!(index in candidate)) {
            encoded += segment("h");
            continue;
          }
          const item = encode(candidate[index]);
          if (!item.ok) return item;
          encoded += segment("e", item.key);
        }
        return { ok: true, key: segment("a", encoded) };
      }

      let encoded = "";
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        return {
          ok: false,
          error: { code: "unsupported", message: "Symbol-keyed properties are not canonical values" },
        };
      }
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || descriptor.get || descriptor.set) {
          return {
            ok: false,
            error: { code: "unsupported", message: "Accessor properties are not canonical values" },
          };
        }
        const item = encode(descriptor.value);
        if (!item.ok) return item;
        encoded += segment("k", key) + segment("v", item.key);
      }
      return { ok: true, key: segment("o", encoded) };
    } finally {
      ancestors.delete(candidate);
    }
  };

  try {
    return encode(value);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: `Canonical value could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function canonicalIdentity(value: unknown): string {
  const result = canonicalValueKey(value);
  return result.ok ? result.key : `!identity-error:${segment("x", `${result.error.code}:${result.error.message}`)}`;
}

function isFailedIdentity(key: string): boolean {
  return key.startsWith("!identity-error:") || key.startsWith("!domain-error:");
}

function resolveIdentity(identity: RelationIdentity, value: unknown): string {
  const result = identity(value);
  if (typeof result === "string") return result;
  return result.ok
    ? result.key
    : `!domain-error:${result.error.family}:${result.error.field}:${result.error.code}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function normalizedDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "invalid-date" : value.toISOString().slice(0, 10);
  }
  const text = String(value);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10);
}

function normalizedText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function normalizedNumber(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

export interface AgeGroupDomainValue {
  label: string | null;
  minAge: number | null;
  maxAge: number | null;
  minGrade: number | null;
  maxGrade: number | null;
}

export interface ScheduleDomainValue {
  label: string | null;
  startDate: string | null;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  earlyDropOff: string | null;
  latePickup: string | null;
}

export interface PricingDomainValue {
  label: string | null;
  amount: number | null;
  unit: string | null;
  durationWeeks: number | null;
  ageQualifier: string | null;
  discountNotes: string | null;
}

export function projectAgeGroupDomain(value: unknown): AgeGroupDomainValue {
  const item = recordOf(value);
  return {
    label: normalizedText(item.label),
    minAge: normalizedNumber(item.minAge),
    maxAge: normalizedNumber(item.maxAge),
    minGrade: normalizedNumber(item.minGrade),
    maxGrade: normalizedNumber(item.maxGrade),
  };
}

export function projectScheduleDomain(value: unknown): ScheduleDomainValue {
  const item = recordOf(value);
  return {
    label: normalizedText(item.label),
    startDate: normalizedDate(item.startDate),
    endDate: normalizedDate(item.endDate),
    startTime: normalizedText(item.startTime),
    endTime: normalizedText(item.endTime),
    earlyDropOff: normalizedText(item.earlyDropOff),
    latePickup: normalizedText(item.latePickup),
  };
}

export function projectPricingDomain(value: unknown): PricingDomainValue {
  const item = recordOf(value);
  return {
    label: normalizedText(item.label),
    amount: normalizedNumber(item.amount),
    unit: normalizedText(item.unit),
    durationWeeks: normalizedNumber(item.durationWeeks),
    ageQualifier: normalizedText(item.ageQualifier),
    discountNotes: normalizedText(item.discountNotes),
  };
}

function domainFailure(
  family: DomainIdentityError["family"],
  field: string,
  message: string,
): DomainIdentityResult {
  return { ok: false, error: { code: "invalid-domain-value", family, field, message } };
}

function encodeDomain(
  family: DomainIdentityError["family"],
  value: AgeGroupDomainValue | ScheduleDomainValue | PricingDomainValue,
): DomainIdentityResult {
  const result = canonicalValueKey(value);
  return result.ok
    ? result
    : {
        ok: false,
        error: {
          code: "canonicalization-failed",
          family,
          field: "*",
          message: result.error.message,
        },
      };
}

function validDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function ageGroupDomainIdentity(value: unknown): DomainIdentityResult {
  const projection = projectAgeGroupDomain(value);
  if (projection.label === null) return domainFailure("ageGroups", "label", "label is required");
  for (const field of ["minAge", "maxAge", "minGrade", "maxGrade"] as const) {
    const candidate = projection[field];
    if (candidate !== null && !Number.isFinite(candidate)) {
      return domainFailure("ageGroups", field, `${field} must be finite when present`);
    }
  }
  return encodeDomain("ageGroups", projection);
}

export function scheduleDomainIdentity(value: unknown): DomainIdentityResult {
  const projection = projectScheduleDomain(value);
  if (projection.label === null) return domainFailure("schedules", "label", "label is required");
  if (!validDate(projection.startDate)) {
    return domainFailure("schedules", "startDate", "startDate is required and must be a valid date");
  }
  if (!validDate(projection.endDate)) {
    return domainFailure("schedules", "endDate", "endDate is required and must be a valid date");
  }
  return encodeDomain("schedules", projection);
}

export function pricingDomainIdentity(value: unknown): DomainIdentityResult {
  const projection = projectPricingDomain(value);
  if (projection.label === null) return domainFailure("pricing", "label", "label is required");
  if (projection.amount === null || !Number.isFinite(projection.amount)) {
    return domainFailure("pricing", "amount", "amount is required and must be finite");
  }
  if (projection.unit === null || projection.unit.length === 0) {
    return domainFailure("pricing", "unit", "unit is required");
  }
  if (projection.durationWeeks !== null && !Number.isFinite(projection.durationWeeks)) {
    return domainFailure("pricing", "durationWeeks", "durationWeeks must be finite when present");
  }
  return encodeDomain("pricing", projection);
}

export function relationDomainIdentity(
  field: "ageGroups" | "schedules" | "pricing"
): RelationIdentity {
  if (field === "ageGroups") return ageGroupDomainIdentity;
  if (field === "schedules") return scheduleDomainIdentity;
  return pricingDomainIdentity;
}

export interface ProvenanceProjectionOptions {
  excerpt?: string;
  sourceUrl?: string;
  /** First-pass proposals historically retain `excerpt: ""`; recrawl omits it. */
  includeEmptyExcerpt?: boolean;
}

export function stableOuterArrayIdentity(value: unknown): string {
  if (!Array.isArray(value)) return canonicalIdentity(value);
  return canonicalIdentity([...value].sort((a, b) => canonicalIdentity(a).localeCompare(canonicalIdentity(b))));
}

function stableObjectString(value: unknown): string {
  if (Array.isArray(value)) return stableOuterArrayIdentity(value);
  if (!value || typeof value !== "object") return String(value ?? "");
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

/** Scalar normalization preserved from the recrawl diff engine. */
export function normalizeScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "object") return stableObjectString(value);
  return String(value).trim().toLowerCase();
}

export function changeWhenDifferent(
  oldValue: unknown,
  newValue: unknown,
  equal: (oldValue: unknown, newValue: unknown) => boolean
): ValueChange | null {
  return equal(oldValue, newValue) ? null : { old: oldValue, new: newValue };
}

export function scalarChange(oldValue: unknown, newValue: unknown): ValueChange | null {
  return changeWhenDifferent(
    oldValue,
    newValue,
    (oldCandidate, newCandidate) => normalizeScalar(oldCandidate) === normalizeScalar(newCandidate)
  );
}

export function outerArrayChange(
  oldValue: unknown[],
  newValue: unknown[],
  identity: RelationIdentity = stableOuterArrayIdentity
): ValueChange | null {
  return changeWhenDifferent(
    oldValue,
    newValue,
    (oldCandidate, newCandidate) => {
      const oldKeys = (oldCandidate as unknown[]).map((value) => resolveIdentity(identity, value)).sort();
      const newKeys = (newCandidate as unknown[]).map((value) => resolveIdentity(identity, value)).sort();
      if (oldKeys.some(isFailedIdentity) || newKeys.some(isFailedIdentity)) return false;
      return canonicalIdentity(oldKeys) === canonicalIdentity(newKeys);
    }
  );
}

export function relationFacts(
  currentItems: unknown[],
  candidateItems: unknown[],
  identity: RelationIdentity = stableOuterArrayIdentity
): RelationFacts {
  const currentIdentities = new Set(currentItems.map((value) => resolveIdentity(identity, value)));
  const remainingCandidateCounts = new Map<string, number>();
  for (const item of candidateItems) {
    const key = resolveIdentity(identity, item);
    if (isFailedIdentity(key)) continue;
    remainingCandidateCounts.set(key, (remainingCandidateCounts.get(key) ?? 0) + 1);
  }

  const allCurrentRetained = currentItems.every((item) => {
    const key = resolveIdentity(identity, item);
    if (isFailedIdentity(key)) return false;
    const remaining = remainingCandidateCounts.get(key) ?? 0;
    if (remaining === 0) return false;
    remainingCandidateCounts.set(key, remaining - 1);
    return true;
  });

  return {
    allCurrentRetained,
    hasNovelCandidate: candidateItems.some((item) => {
      const key = resolveIdentity(identity, item);
      return isFailedIdentity(key) || !currentIdentities.has(key);
    }),
  };
}

/** Preserve excerpt-before-sourceUrl ordering and each caller's omission policy. */
export function projectProvenance({
  excerpt,
  sourceUrl,
  includeEmptyExcerpt = false,
}: ProvenanceProjectionOptions): { excerpt?: string; sourceUrl?: string } {
  return {
    ...(includeEmptyExcerpt || excerpt ? { excerpt: excerpt ?? "" } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}
