/**
 * CSV Ingestion Adapter — parses Denver Camps CSV files into normalized CampInput records.
 *
 * Handles four CSV file types with different column structures:
 * - Main (summer day camps) — 40+ columns with week availability
 * - Sleepaway — simpler structure, different pricing patterns
 * - Winter break — holiday-specific date columns
 * - School break — single-day off columns
 */

import { CampType, DataConfidence, SUMMER_WEEKS } from "@/lib/types";
import { CampInput, DataIngestionAdapter, IngestionResult, SourceType } from "./adapter";
import { parsePricing } from "./price-parser";
import { parseAgeGroups, parseColumnAgeMarker } from "./age-parser";
import { parseHours, parseEarlyDropOff, parseLatePickup, parseWeekColumns, parseWeeksRunField } from "./schedule-parser";
import { classifyCategory, inferCategoryFromText } from "./category-classifier";
import { parseRegistrationStatus, parseRegistrationDate } from "./registration-parser";

/**
 * Which type of CSV file is being parsed.
 * Determines column mapping and camp type.
 */
export type CsvFileType = "summer" | "sleepaway" | "family" | "winter" | "break" | "virtual";

const FILE_TYPE_TO_CAMP_TYPE: Record<CsvFileType, CampType> = {
  summer: "SUMMER_DAY",
  sleepaway: "SLEEPAWAY",
  family: "FAMILY",
  winter: "WINTER_BREAK",
  break: "SCHOOL_BREAK",
  virtual: "VIRTUAL",
};

export class CsvIngestionAdapter implements DataIngestionAdapter {
  readonly sourceType: SourceType = "CSV";

  constructor(
    private rows: Record<string, string>[],
    private fileType: CsvFileType
  ) {}

  async fetch(): Promise<Record<string, string>[]> {
    return this.rows;
  }

  normalize(row: Record<string, string>): CampInput | null {
    const name = findColumn(row, ["Name", "name"])?.trim();
    if (!name) return null;

    // Skip header/instruction rows
    if (name.toLowerCase().includes("2026 notes") || name.toLowerCase().includes("updater")) {
      return null;
    }

    const campType = FILE_TYPE_TO_CAMP_TYPE[this.fileType];

    // ── Category ──
    const rawCategory = findColumn(row, ["Category", "category"]) || "";
    let category = classifyCategory(rawCategory);
    const description = findColumn(row, ["Description", "description"]) || "";
    if (category === "OTHER") {
      category = inferCategoryFromText(name, description);
    }

    // ── Location ──
    const neighborhood = findColumn(row, ["Part of Town", "part of town"]) || "";
    const address = findColumn(row, ["Location", "location"]) || "";

    // ── Hours ──
    const rawHours = findColumn(row, ["Hours", "hours"]) || "";
    const hours = parseHours(rawHours);

    // ── Early drop off / Late pickup ──
    const rawEarlyDropOff = findColumn(row, [
      "Early Drop Off (8-9 am) Y/N or time",
      "Early Drop Off",
      "early drop off",
    ]) || "";
    const rawLatePickup = findColumn(row, [
      "Late Pick up (after 4) (Y/N or latest time)",
      "Late Pick up",
      "late pick up",
    ]) || "";
    const earlyDropOff = parseEarlyDropOff(rawEarlyDropOff);
    const latePickup = parseLatePickup(rawLatePickup);

    // ── Pricing ──
    const rawCost = findColumn(row, [
      "Cost Per Week, if Blue 2025 info",
      "Cost Per Week",
      "cost per week",
    ]) || "";
    const rawDiscounts = findColumn(row, ["Discounts Offered", "discounts offered"]) || "";
    const pricing = parsePricing(rawCost, rawDiscounts);

    // ── Ages ──
    const ageGroups = this.parseAges(row);

    // ── Registration ──
    const rawRegStatus = findColumn(row, [
      "Registration Status",
      "registration status",
    ]) || "";
    const registrationStatus = parseRegistrationStatus(rawRegStatus);

    const rawRegDate = findColumn(row, [
      "Registration Date",
      "registration date",
    ]) || "";
    const { date: registrationOpenDate, time: registrationOpenTime } =
      parseRegistrationDate(rawRegDate);

    // ── Schedule ──
    const schedules = this.parseSchedules(row, hours, earlyDropOff, latePickup);

    // ── Other fields ──
    const rawLunch = findColumn(row, ["Lunch", "lunch"]) || "";
    const lunchIncluded = /yes|included|provided/i.test(rawLunch);

    const websiteUrl = findColumn(row, ["Link", "link"]) || "";
    const notes = findColumn(row, ["Notes", "notes"]) || null;
    const interestingDetails = findColumn(row, [
      "Interesting Camp Sessions",
      "interesting camp sessions",
    ]) || null;

    // ── Data confidence ──
    const rawConfidence = findColumn(row, [
      "2025 Info Released Yet?",
      "2024 Info Released Yet?",
      "2025/2026 Info Released Yet?",
    ]) || "";
    const dataConfidence: DataConfidence =
      rawConfidence.toLowerCase() === "y" || rawConfidence.toLowerCase() === "yes"
        ? "VERIFIED"
        : "PLACEHOLDER";

    // ── Slug ──
    const slug = slugify(name);

    // ── City ──
    const city = extractCity(address) || "Denver";

    return {
      slug,
      name,
      description,
      notes,
      campType,
      category,
      websiteUrl,
      interestingDetails,
      city,
      region: null,
      neighborhood,
      address,
      latitude: null,
      longitude: null,
      lunchIncluded,
      registrationOpenDate,
      registrationOpenTime,
      registrationStatus,
      sourceType: "CSV",
      sourceUrl: null,
      dataConfidence,
      ageGroups,
      schedules,
      pricing,
    };
  }

  async ingest(): Promise<IngestionResult> {
    const rows = await this.fetch();
    const result: IngestionResult = {
      total: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    for (let i = 0; i < rows.length; i++) {
      try {
        const camp = this.normalize(rows[i]);
        if (camp) {
          result.created++;
        } else {
          result.skipped++;
        }
      } catch (error) {
        const name = findColumn(rows[i], ["Name", "name"]) || `Row ${i}`;
        result.errors.push({
          row: i,
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  private parseAges(row: Record<string, string>): CampInput["ageGroups"] {
    // First, try the main "Ages/Grades" column
    const rawAges = findColumn(row, ["Ages/Grades", "ages/grades"]) || "";
    const mainAges = parseAgeGroups(rawAges);

    if (mainAges.length > 0) return mainAges;

    // If no main ages, try individual grade columns (summer CSV)
    const gradeColumns = [
      "PreK",
      "Kindergarten (ages 5-6)",
      "1st-2nd Grades (Ages 6-8)",
      "3-4th Grades (Ages 8-10)",
      "5th-6th Grades (ages 9-11)",
      "7th-8th Grades (ages 11-13)",
      "9th and 10th Grades (ages 13-16)",
      "11th and 12th Grades (ages 16-18)",
    ];

    const columnAges: CampInput["ageGroups"] = [];
    for (const col of gradeColumns) {
      const value = row[col];
      if (value) {
        const parsed = parseColumnAgeMarker(col, value);
        if (parsed) columnAges.push(parsed);
      }
    }

    // Merge contiguous grade ranges into a single group
    if (columnAges.length > 0) {
      return mergeContiguousAgeGroups(columnAges);
    }

    return [];
  }

  private parseSchedules(
    row: Record<string, string>,
    hours: { startTime: string | null; endTime: string | null },
    earlyDropOff: string | null,
    latePickup: string | null
  ): CampInput["schedules"] {
    if (this.fileType === "summer") {
      // Use week columns
      const weekColumnNames = SUMMER_WEEKS.map((w) => {
        // Find matching column name in the row
        const keys = Object.keys(row);
        const match = keys.find((k) => k.includes(w.label) || k.includes(w.label.replace("-", "–")));
        return match || w.label;
      });
      return parseWeekColumns(row, weekColumnNames, hours, earlyDropOff, latePickup);
    }

    if (this.fileType === "sleepaway" || this.fileType === "family") {
      const rawWeeks = findColumn(row, ["Weeks Run", "weeks run"]) || "";
      return parseWeeksRunField(rawWeeks, hours);
    }

    if (this.fileType === "winter") {
      return this.parseDateColumns(row, hours, earlyDropOff, latePickup, [
        { col: "Dec 22-26 (Holiday Week)", start: "2026-12-22", end: "2026-12-26" },
        { col: "Dec 29-Jan 2 (Holiday Week)", start: "2026-12-29", end: "2027-01-02" },
        { col: "Dec 30-31", start: "2026-12-30", end: "2026-12-31" },
        { col: "Jan 2-3", start: "2027-01-02", end: "2027-01-03" },
        { col: "Jan 5-7", start: "2027-01-05", end: "2027-01-07" },
      ]);
    }

    if (this.fileType === "break") {
      return this.parseDateColumns(row, hours, earlyDropOff, latePickup, [
        { col: "January 19th - MLK day", start: "2026-01-19", end: "2026-01-19" },
        { col: "Feb 16th - President's Day", start: "2026-02-16", end: "2026-02-16" },
        { col: "Feb 27th - Prof dev day", start: "2026-02-27", end: "2026-02-27" },
        { col: "May 1 - Prof dev day", start: "2026-05-01", end: "2026-05-01" },
      ]);
    }

    return [];
  }

  private parseDateColumns(
    row: Record<string, string>,
    hours: { startTime: string | null; endTime: string | null },
    earlyDropOff: string | null,
    latePickup: string | null,
    dateColumns: { col: string; start: string; end: string }[]
  ): CampInput["schedules"] {
    const schedules: CampInput["schedules"] = [];

    for (const dc of dateColumns) {
      const value = findColumn(row, [dc.col])?.trim().toLowerCase() || "";
      if (value && value !== "n" && value !== "no" && value !== "") {
        schedules.push({
          label: dc.col,
          startDate: dc.start,
          endDate: dc.end,
          startTime: hours.startTime,
          endTime: hours.endTime,
          earlyDropOff,
          latePickup,
        });
      }
    }

    return schedules;
  }
}

// ─── Helpers ─────────────────────────────────────────────

function findColumn(row: Record<string, string>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    // Exact match
    if (row[candidate] !== undefined) return row[candidate];
  }
  // Case-insensitive match
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const match = keys.find((k) => k.toLowerCase() === lower);
    if (match) return row[match];
  }
  // Partial match
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const match = keys.find((k) => k.toLowerCase().includes(lower));
    if (match) return row[match];
  }
  return undefined;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function extractCity(address: string): string | null {
  if (!address) return null;
  // Try to extract city from address like "4605 Quebec St. Denver, CO 80216"
  const match = address.match(/,?\s*([A-Za-z\s]+),?\s*CO/i);
  if (match) return match[1].trim();
  // Check for known cities
  const cities = ["Denver", "Evergreen", "Estes Park", "Boulder", "Lakewood", "Littleton", "Arvada", "Golden", "Bailey"];
  for (const city of cities) {
    if (address.includes(city)) return city;
  }
  return null;
}

function mergeContiguousAgeGroups(
  groups: CampInput["ageGroups"]
): CampInput["ageGroups"] {
  if (groups.length <= 1) return groups;

  // Sort by minAge
  const sorted = [...groups].sort((a, b) => (a.minAge ?? 0) - (b.minAge ?? 0));

  const merged: CampInput["ageGroups"] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    // If contiguous or overlapping, merge
    if (
      prev.maxAge !== null &&
      curr.minAge !== null &&
      curr.minAge <= (prev.maxAge ?? 0) + 2
    ) {
      prev.maxAge = Math.max(prev.maxAge ?? 0, curr.maxAge ?? 0);
      prev.maxGrade = Math.max(prev.maxGrade ?? 0, curr.maxGrade ?? 0);
      prev.label = `Ages ${prev.minAge}-${prev.maxAge}`;
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
