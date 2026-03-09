/**
 * scraper-utils.ts — shared parsing helpers used across all scrapers.
 */

import { CampCategory, CampType } from "@/lib/types";
import { classifyCategory } from "./category-classifier";
import { parseAgeGroups } from "./age-parser";
import { parsePricing } from "./price-parser";

// ─── Slug ─────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ─── Date normalization ───────────────────────────────────────────────────

/**
 * Parse a wide variety of date strings into ISO YYYY-MM-DD.
 * Returns null if parsing fails.
 */
export function parseDate(raw: string): string | null {
  if (!raw?.trim()) return null;

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  // MM/DD/YYYY or M/D/YYYY
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // "June 9, 2026" or "Jun 9 2026"
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const wordMatch = raw.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (wordMatch) {
    const [, mon, d, y] = wordMatch;
    const m = months[mon.toLowerCase()];
    if (m) return `${y}-${m}-${d.padStart(2, "0")}`;
  }

  return null;
}

/**
 * Parse a time string like "9:00 AM" → "9:00 AM", "9am" → "9:00 AM", "13:00" → "1:00 PM"
 */
export function parseTime(raw: string): string | null {
  if (!raw?.trim()) return null;

  // Already "H:MM AM/PM"
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(raw.trim())) {
    return raw.trim().toUpperCase();
  }

  // 24h "13:00"
  const h24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1]);
    const m = h24[2];
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${m} ${period}`;
  }

  // "9am", "9:30pm"
  const ampm = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampm) {
    const h = ampm[1];
    const m = ampm[2] ?? "00";
    const period = ampm[3].toUpperCase();
    return `${h}:${m} ${period}`;
  }

  return null;
}

// ─── Price extraction ─────────────────────────────────────────────────────

/** Extract dollar amounts from a text block */
export function extractPrices(text: string) {
  return parsePricing(text, "");
}

// ─── Age extraction ───────────────────────────────────────────────────────

export function extractAgeGroups(text: string) {
  return parseAgeGroups(text);
}

// ─── Category inference ───────────────────────────────────────────────────

export function inferCategory(raw: string, fallbackText = ""): CampCategory {
  const direct = classifyCategory(raw);
  if (direct !== "OTHER") return direct;
  return classifyCategory(fallbackText);
}
