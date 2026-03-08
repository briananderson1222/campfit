/**
 * Registration status and date parser for Denver Camps CSV data.
 *
 * Status formats: "open", "Open", "OPEN!", "Open now", "Open/rolling",
 *   "Filling quickly", "Waitlist", "Closed", "TBD", "By appointment",
 *   "Open to members", "Open to Public 3/1/21", etc.
 *
 * Date formats: "January 27, 2026 (members) at 10 a.m.",
 *   "Opens 12/5", "1/13 members; 1/17 nonmembers", "Dec 9", etc.
 */

import { RegistrationStatus } from "@/lib/types";

export interface ParsedRegistration {
  status: RegistrationStatus;
  openDate: string | null; // ISO date
  openTime: string | null; // display string
}

export function parseRegistrationStatus(raw: string): RegistrationStatus {
  if (!raw || !raw.trim()) return "UNKNOWN";

  const lower = raw.trim().toLowerCase();

  if (
    lower === "closed" ||
    lower === "full" ||
    lower === "sold out" ||
    lower.includes("closed")
  ) {
    return "CLOSED";
  }

  if (
    lower.includes("waitlist") ||
    lower.includes("wait list") ||
    lower.includes("filling")
  ) {
    return "WAITLIST";
  }

  if (
    lower === "tbd" ||
    lower === "coming soon" ||
    lower.includes("not yet") ||
    lower.includes("coming soon")
  ) {
    return "COMING_SOON";
  }

  if (
    lower.includes("open") ||
    lower.includes("rolling") ||
    lower === "yes" ||
    lower === "y" ||
    lower.includes("available") ||
    lower.includes("accepting") ||
    lower.includes("by appointment")
  ) {
    return "OPEN";
  }

  // If it looks like a date, registration is coming soon
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2})/i.test(lower)) {
    return "COMING_SOON";
  }

  return "UNKNOWN";
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export function parseRegistrationDate(raw: string): { date: string | null; time: string | null } {
  if (!raw || !raw.trim()) return { date: null, time: null };

  const cleaned = raw.trim();
  let time: string | null = null;

  // Extract time if present: "at 10 a.m.", "at 9:00 AM", "12:00 AM"
  const timeMatch = cleaned.match(
    /(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/i
  );
  if (timeMatch) {
    time = normalizeTime(timeMatch[1]);
  }

  // Try "Month Day, Year" format: "January 27, 2026"
  const fullDateMatch = cleaned.match(
    /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i
  );
  if (fullDateMatch) {
    const m = MONTHS[fullDateMatch[1].toLowerCase()];
    if (m) {
      const date = `2026-${String(m).padStart(2, "0")}-${fullDateMatch[2].padStart(2, "0")}`;
      return { date, time };
    }
  }

  // Try "Month Day" without year: "Dec 9", "January 27"
  const monthDayMatch = cleaned.match(
    /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?/i
  );
  if (monthDayMatch) {
    const m = MONTHS[monthDayMatch[1].toLowerCase()];
    if (m) {
      const date = `2026-${String(m).padStart(2, "0")}-${monthDayMatch[2].padStart(2, "0")}`;
      return { date, time };
    }
  }

  // Try "Opens M/D" or "M/D" format: "1/13", "Opens 12/5"
  const slashMatch = cleaned.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slashMatch) {
    const year = slashMatch[3]
      ? slashMatch[3].length === 2
        ? `20${slashMatch[3]}`
        : slashMatch[3]
      : "2026";
    const date = `${year}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
    return { date, time };
  }

  return { date: null, time };
}

function normalizeTime(raw: string): string | null {
  if (!raw) return null;
  let cleaned = raw.trim().toLowerCase();
  cleaned = cleaned.replace(/a\.?m\.?/g, "am").replace(/p\.?m\.?/g, "pm");
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return null;
  const hour = parseInt(match[1]);
  const minute = match[2] || "00";
  const period = match[3].toUpperCase();
  return `${hour}:${minute} ${period}`;
}
