import type { CampInput } from "./adapter";
import { meanReportedConfidence, type AssembledItem } from "./traverse-item-grouping";
import { ITEM_FIELD_PATHS } from "./traverse-schema";
import { plainLabel } from "./plain-label";

export { plainLabel };

/** Where one row of a proposed list was read: its verbatim excerpt and that excerpt's `chars:` locator. */
export interface RowCitation {
  excerpt: string;
  locator?: string;
  /**
   * Sessions only: where the row's start and end time were read, one entry
   * per distinct excerpt. Present exactly when the crawl stated the row's
   * time; `excerpt` above then cites its dates.
   */
  times?: { excerpt: string; locator?: string }[];
  /** Sessions only: the time is the page's one daily time, applied to every session; the page line it was read from. */
  timePageWide?: string;
  /**
   * Sessions only: present when the dates' own text states no year and the
   * year was taken from another excerpt on the page (session-year.ts). That
   * excerpt states exactly one year, the dates' year.
   */
  year?: { excerpt: string; locator?: string };
}

function rowCitation(excerpt: string, locator: string): RowCitation {
  return { excerpt, ...(locator ? { locator } : {}) };
}

/** One proposed session row: its dates' citation, plus its time's when the page stated one, and its year's when taken from another excerpt. */
export function scheduleRowCitation(row: AssembledItem["schedules"][number]): RowCitation {
  return {
    ...rowCitation(row.label, row.locator),
    ...(row.timeCitations.length > 0 ? { times: row.timeCitations.map((time) => rowCitation(time.excerpt, time.locator)) } : {}),
    ...(row.timePageWideLine ? { timePageWide: row.timePageWideLine } : {}),
    ...(row.yearCitation ? { year: rowCitation(row.yearCitation.excerpt, row.yearCitation.locator) } : {}),
  };
}

/** One proposed session row's value. A time the page did not state stays null. */
export function scheduleRowValue(row: AssembledItem["schedules"][number]) {
  return { label: plainLabel(row.label), startDate: row.startDate ?? "", endDate: row.endDate ?? "", startTime: row.startTime, endTime: row.endTime, earlyDropOff: null, latePickup: null };
}

/** An unreported confidence leaves the field out, which computeDiff reads as unknown. */
function setConfidence(confidence: Record<string, number>, field: string, value: number | undefined): void {
  if (value !== undefined) confidence[field] = value;
}

/** Pure projection from a grouped Traverse item into computeDiff inputs. */
export function assembledItemToDiffInputs(item: AssembledItem): {
  extracted: Partial<CampInput>;
  confidence: Record<string, number>;
  excerpts: Record<string, string>;
  /** `chars:` locator of each field's excerpt in the prepared text, for exact citation checks. */
  locators: Record<string, string>;
  /** For each list field, one citation per proposed row, in row order. */
  rowCitations: Record<string, RowCitation[]>;
} {
  const extracted: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  const excerpts: Record<string, string> = {};
  const locators: Record<string, string> = {};
  const rowCitations: Record<string, RowCitation[]> = {};
  for (const path of ITEM_FIELD_PATHS) {
    const fp = item.scalars[path];
    if (!fp) continue;
    extracted[path] = fp.candidateValue;
    if (fp.confidence !== undefined) confidence[path] = fp.confidence;
    if (fp.excerpt) excerpts[path] = fp.excerpt;
    if (fp.excerpt && fp.locator) locators[path] = fp.locator;
  }
  if (item.ageGroups.length > 0) {
    extracted.ageGroups = item.ageGroups.map((v) => ({ label: plainLabel(v.label), minAge: v.minAge, maxAge: v.maxAge, minGrade: null, maxGrade: null }));
    setConfidence(confidence, "ageGroups", meanReportedConfidence(item.ageGroups.map((v) => v.confidence)));
    rowCitations.ageGroups = item.ageGroups.map((v) => rowCitation(v.label, v.locator));
    if (item.ageGroups[0]?.label) excerpts.ageGroups = item.ageGroups[0].label;
    if (item.ageGroups[0]?.label && item.ageGroups[0].locator) locators.ageGroups = item.ageGroups[0].locator;
  }
  if (item.schedules.length > 0) {
    extracted.schedules = item.schedules.map(scheduleRowValue);
    setConfidence(confidence, "schedules", meanReportedConfidence(item.schedules.map((v) => v.confidence)));
    rowCitations.schedules = item.schedules.map(scheduleRowCitation);
    if (item.schedules[0]?.label) excerpts.schedules = item.schedules[0].label;
    if (item.schedules[0]?.label && item.schedules[0].locator) locators.schedules = item.schedules[0].locator;
  }
  if (item.pricing.length > 0) {
    extracted.pricing = item.pricing.map((v) => ({ label: plainLabel(v.label), amount: v.amount, unit: v.unit, durationWeeks: null, ageQualifier: null, discountNotes: null }));
    setConfidence(confidence, "pricing", meanReportedConfidence(item.pricing.map((v) => v.confidence)));
    rowCitations.pricing = item.pricing.map((v) => rowCitation(v.label, v.locator));
    if (item.pricing[0]?.label) excerpts.pricing = item.pricing[0].label;
    if (item.pricing[0]?.label && item.pricing[0].locator) locators.pricing = item.pricing[0].locator;
  }
  for (const field of ["campTypes", "categories"] as const) {
    if (item[field].length === 0) continue;
    (extracted as Record<string, unknown>)[field] = item[field].map((v) => v.value);
    setConfidence(confidence, field, meanReportedConfidence(item[field].map((v) => v.confidence)));
    rowCitations[field] = item[field].map((v) => rowCitation(v.excerpt, v.locator));
    if (item[field][0]?.excerpt) excerpts[field] = item[field][0].excerpt;
    if (item[field][0]?.excerpt && item[field][0].locator) locators[field] = item[field][0].locator;
  }
  return { extracted: extracted as Partial<CampInput>, confidence, excerpts, locators, rowCitations };
}
