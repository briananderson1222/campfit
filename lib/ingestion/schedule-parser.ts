/**
 * Schedule parser for Denver Camps CSV data.
 *
 * Handles:
 *   - Week columns (Y/N/X/blank/text) → individual CampSchedule records
 *   - Hours field: "9am to 3pm", "9am-12pm Half Day / 12pm-3pm Half Day"
 *   - Early drop off: "Y", "N", "8:15 AM", "Y - 7:30 - 8:30am"
 *   - Late pickup: "Y", "N", "5:00 PM", "Y 5:00 PM"
 *   - Sleepaway "Weeks Run" field: "June 10-July 6, July 8-August 3"
 */

import { SUMMER_WEEKS } from "@/lib/types";

export interface ParsedSchedule {
  label: string;
  startDate: string; // ISO date
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  earlyDropOff: string | null;
  latePickup: string | null;
}

export interface ParsedHours {
  startTime: string | null;
  endTime: string | null;
}

/**
 * Parse the week availability columns from the main CSV.
 * Each column header is like "June 1-5", "June 8-12", etc.
 * Values: "Y", "X" = available; "N", blank = unavailable; text = thematic name (also available)
 */
export function parseWeekColumns(
  row: Record<string, string>,
  weekColumnNames: string[],
  hours: ParsedHours,
  earlyDropOff: string | null,
  latePickup: string | null
): ParsedSchedule[] {
  const schedules: ParsedSchedule[] = [];

  for (let i = 0; i < weekColumnNames.length; i++) {
    const colName = weekColumnNames[i];
    const value = (row[colName] || "").trim().toLowerCase();

    // Skip if unavailable
    if (!value || value === "n" || value === "no" || value === "no camp") {
      continue;
    }

    // Available if Y, X, or any other non-empty text (could be theme name)
    const week = SUMMER_WEEKS[i];
    if (!week) continue;

    schedules.push({
      label: `Week of ${week.label}`,
      startDate: week.start,
      endDate: week.end,
      startTime: hours.startTime,
      endTime: hours.endTime,
      earlyDropOff,
      latePickup,
    });
  }

  return schedules;
}

/**
 * Parse hours field from CSV.
 * Handles: "9am to 3pm", "9:00 AM - 3:00 PM", "half or full day",
 *          "9am-3pm Full-Day / 9am-12pm Half Day", etc.
 *
 * Returns the primary (longest/full-day) schedule hours.
 */
export function parseHours(raw: string): ParsedHours {
  if (!raw || !raw.trim()) {
    return { startTime: null, endTime: null };
  }

  const cleaned = raw.trim();

  // Try to find a time range pattern
  const timeRanges = extractTimeRanges(cleaned);

  if (timeRanges.length === 0) {
    return { startTime: null, endTime: null };
  }

  // Prefer full-day range (longest duration) or first mentioned
  if (timeRanges.length === 1) {
    return timeRanges[0];
  }

  // If multiple ranges, pick the one labeled "full day" or the longest
  const fullDay = timeRanges.find((_r, i) => {
    const context = cleaned.toLowerCase();
    // Rough heuristic: full day is usually the widest range
    return context.includes("full") && i === 0;
  });

  if (fullDay) return fullDay;

  // Return the widest range
  return timeRanges.sort((a, b) => {
    const durA = timeDuration(a.startTime, a.endTime);
    const durB = timeDuration(b.startTime, b.endTime);
    return durB - durA;
  })[0];
}

function extractTimeRanges(raw: string): ParsedHours[] {
  const results: ParsedHours[] = [];

  // Match patterns like "9am to 3pm", "9:00 AM - 3:00 PM", "9am-12pm"
  const timePattern =
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?))\s*(?:to|-|–|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?))/gi;

  let match;
  while ((match = timePattern.exec(raw)) !== null) {
    const startTime = normalizeTime(match[1]);
    const endTime = normalizeTime(match[2]);
    if (startTime && endTime) {
      results.push({ startTime, endTime });
    }
  }

  return results;
}

/**
 * Parse early drop-off field.
 * Handles: "N", "Y", "8:15 AM", "Y - 7:30 - 8:30am", "8:00 AM"
 */
export function parseEarlyDropOff(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  const cleaned = raw.trim();
  const lower = cleaned.toLowerCase();

  if (lower === "n" || lower === "no") return null;

  // Extract a specific time
  const timeMatch = cleaned.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?))/i
  );
  if (timeMatch) {
    return normalizeTime(timeMatch[1]);
  }

  // "Y" without a time — assume 8:00 AM (standard early drop-off)
  if (lower === "y" || lower === "yes" || lower.startsWith("y ") || lower.startsWith("y-")) {
    return "8:00 AM";
  }

  return null;
}

/**
 * Parse late pickup field.
 * Handles: "N", "Y", "5:00 PM", "Y 5:00 PM", "Y - 4:30 PM"
 */
export function parseLatePickup(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  const cleaned = raw.trim();
  const lower = cleaned.toLowerCase();

  if (lower === "n" || lower === "no") return null;

  // Extract a specific time
  const timeMatch = cleaned.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.?m\.?|p\.?m\.?))/i
  );
  if (timeMatch) {
    return normalizeTime(timeMatch[1]);
  }

  // "Y" without a time — assume 5:00 PM
  if (lower === "y" || lower === "yes" || lower.startsWith("y ") || lower.startsWith("y-")) {
    return "5:00 PM";
  }

  return null;
}

/**
 * Parse the "Weeks Run" field from sleepaway/family CSVs.
 * Handles: "June 10-July 6, July 8-August 3", "6/1-8/1, one week and two week options"
 */
export function parseWeeksRunField(
  raw: string,
  hours: ParsedHours
): ParsedSchedule[] {
  if (!raw || !raw.trim()) return [];

  const schedules: ParsedSchedule[] = [];
  const cleaned = raw.trim();

  // Try to extract date ranges
  const dateRangePattern =
    /(?:(\w+)\s+(\d{1,2}))\s*(?:to|-|–)\s*(?:(\w+)\s+)?(\d{1,2})(?:\s*,\s*(\d{4}))?/gi;

  let match;
  let idx = 0;
  while ((match = dateRangePattern.exec(cleaned)) !== null) {
    const startMonth = match[1];
    const startDay = match[2];
    const endMonth = match[3] || startMonth;
    const endDay = match[4];
    const year = match[5] || "2026";

    const startDate = monthDayToISO(startMonth, startDay, year);
    const endDate = monthDayToISO(endMonth, endDay, year);

    if (startDate && endDate) {
      idx++;
      schedules.push({
        label: idx === 1 ? "Session 1" : `Session ${idx}`,
        startDate,
        endDate,
        startTime: hours.startTime,
        endTime: hours.endTime,
        earlyDropOff: null,
        latePickup: null,
      });
    }
  }

  // Also try slash date format: "6/1-8/1"
  if (schedules.length === 0) {
    const slashPattern = /(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})/g;
    while ((match = slashPattern.exec(cleaned)) !== null) {
      const startDate = `2026-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
      const endDate = `2026-${match[3].padStart(2, "0")}-${match[4].padStart(2, "0")}`;
      idx++;
      schedules.push({
        label: `Session ${idx}`,
        startDate,
        endDate,
        startTime: hours.startTime,
        endTime: hours.endTime,
        earlyDropOff: null,
        latePickup: null,
      });
    }
  }

  return schedules;
}

// ─── Helpers ─────────────────────────────────────────────

function normalizeTime(raw: string): string | null {
  if (!raw) return null;

  let cleaned = raw.trim().toLowerCase();
  // Normalize am/pm
  cleaned = cleaned.replace(/a\.?m\.?/g, "am").replace(/p\.?m\.?/g, "pm");
  cleaned = cleaned.replace(/\s+/g, " ");

  // Parse hour and minute
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return null;

  let hour = parseInt(match[1]);
  const minute = match[2] || "00";
  const period = match[3].toUpperCase();

  // Format as "H:MM AM/PM"
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

function timeDuration(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const toMinutes = (t: string): number => {
    const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);
    if (!m) return 0;
    let h = parseInt(m[1]);
    if (m[3] === "PM" && h !== 12) h += 12;
    if (m[3] === "AM" && h === 12) h = 0;
    return h * 60 + parseInt(m[2]);
  };
  return toMinutes(end) - toMinutes(start);
}

const MONTHS: Record<string, string> = {
  january: "01", jan: "01",
  february: "02", feb: "02",
  march: "03", mar: "03",
  april: "04", apr: "04",
  may: "05",
  june: "06", jun: "06",
  july: "07", jul: "07",
  august: "08", aug: "08",
  september: "09", sep: "09",
  october: "10", oct: "10",
  november: "11", nov: "11",
  december: "12", dec: "12",
};

function monthDayToISO(month: string, day: string, year: string): string | null {
  const m = MONTHS[month.toLowerCase()];
  if (!m) return null;
  return `${year}-${m}-${day.padStart(2, "0")}`;
}
