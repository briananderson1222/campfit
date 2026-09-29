import type { CampInput } from "./adapter";
import { meanReportedConfidence, type AssembledItem } from "./traverse-item-grouping";
import { SCALAR_SCHEMA_PATHS } from "./traverse-schema";

/** An unreported confidence leaves the field out, which computeDiff reads as unknown. */
function setConfidence(confidence: Record<string, number>, field: string, value: number | undefined): void {
  if (value !== undefined) confidence[field] = value;
}

/** Pure projection from a grouped Traverse item into computeDiff inputs. */
export function assembledItemToDiffInputs(item: AssembledItem): {
  extracted: Partial<CampInput>;
  confidence: Record<string, number>;
  excerpts: Record<string, string>;
} {
  const extracted: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const excerpts: Record<string, string> = {};
  for (const path of SCALAR_SCHEMA_PATHS) {
    const fp = item.scalars[path];
    if (!fp) continue;
    extracted[path] = fp.candidateValue;
    if (fp.confidence !== undefined) confidence[path] = fp.confidence;
    if (fp.excerpt) excerpts[path] = fp.excerpt;
  }
  if (item.ageGroups.length > 0) {
    extracted.ageGroups = item.ageGroups.map((v) => ({ label: v.label, minAge: v.minAge, maxAge: v.maxAge, minGrade: null, maxGrade: null }));
    setConfidence(confidence, "ageGroups", meanReportedConfidence(item.ageGroups.map((v) => v.confidence)));
    if (item.ageGroups[0]?.label) excerpts.ageGroups = item.ageGroups[0].label;
  }
  if (item.schedules.length > 0) {
    extracted.schedules = item.schedules.map((v) => ({ label: v.label, startDate: v.startDate ?? "", endDate: v.endDate ?? "", startTime: null, endTime: null, earlyDropOff: null, latePickup: null }));
    setConfidence(confidence, "schedules", meanReportedConfidence(item.schedules.map((v) => v.confidence)));
    if (item.schedules[0]?.label) excerpts.schedules = item.schedules[0].label;
  }
  if (item.pricing.length > 0) {
    extracted.pricing = item.pricing.map((v) => ({ label: v.label, amount: v.amount, unit: v.unit, durationWeeks: null, ageQualifier: null, discountNotes: null }));
    setConfidence(confidence, "pricing", meanReportedConfidence(item.pricing.map((v) => v.confidence)));
    if (item.pricing[0]?.label) excerpts.pricing = item.pricing[0].label;
  }
  for (const field of ["campTypes", "categories"] as const) {
    if (item[field].length === 0) continue;
    (extracted as Record<string, unknown>)[field] = item[field].map((v) => v.value);
    setConfidence(confidence, field, meanReportedConfidence(item[field].map((v) => v.confidence)));
    if (item[field][0]?.excerpt) excerpts[field] = item[field][0].excerpt;
  }
  return { extracted: extracted as Partial<CampInput>, confidence, excerpts };
}
