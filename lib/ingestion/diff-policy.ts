import {
  canonicalValueKey,
  type DiffKernelError,
  type IdentityResult,
} from "@kontourai/lookout";

export type RelationField = "ageGroups" | "schedules" | "pricing";

export interface DomainIdentityError {
  readonly code: "invalid-domain-value" | "canonicalization-failed";
  readonly family: RelationField;
  readonly field: string;
  readonly message: string;
}

export type DomainIdentityResult = IdentityResult<string>;

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

function kernelError(kind: DiffKernelError["kind"], message: string): DomainIdentityResult {
  return { ok: false, error: { kind, message } };
}

function domainFailure(family: RelationField, field: string, message: string): DomainIdentityResult {
  return kernelError("unsupported-value", `${family}.${field}: ${message}`);
}

function encodeDomain(
  family: RelationField,
  value: AgeGroupDomainValue | ScheduleDomainValue | PricingDomainValue,
): DomainIdentityResult {
  const result = canonicalValueKey(value);
  return result.ok
    ? result
    : kernelError(result.error.kind, `${family} projection could not be canonicalized`);
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

export function relationDomainIdentity(field: RelationField): (value: unknown) => DomainIdentityResult {
  if (field === "ageGroups") return ageGroupDomainIdentity;
  if (field === "schedules") return scheduleDomainIdentity;
  return pricingDomainIdentity;
}

/** Scalar normalization remains CampFit policy; Lookout compares the result. */
export function normalizeScalar(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return [...value].sort((left, right) => {
      const leftKey = canonicalValueKey(left);
      if (!leftKey.ok) throw new Error("scalar array item could not be canonicalized");
      const rightKey = canonicalValueKey(right);
      if (!rightKey.ok) throw new Error("scalar array item could not be canonicalized");
      return leftKey.key.localeCompare(rightKey.key);
    });
  }
  if (typeof value === "object") return value;
  return String(value).trim().toLowerCase();
}

export interface ProvenanceProjectionOptions {
  excerpt?: string;
  sourceUrl?: string;
  includeEmptyExcerpt?: boolean;
}

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

/** A kernel error is always review-visible and never additive. */
export function conservativeReviewError(error: DiffKernelError): {
  readonly changed: true;
  readonly additive: false;
  readonly error: DiffKernelError;
} {
  return { changed: true, additive: false, error };
}
