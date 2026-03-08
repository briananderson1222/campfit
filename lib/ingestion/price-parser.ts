/**
 * Price parser for Denver Camps CSV data.
 *
 * Handles formats like:
 *   "$300/week per session (am/pm)"
 *   "$400- Half Day, $550 Full Day"
 *   "$1349 for one week, $2399 for two weeks, $3499 for three weeks"
 *   "$1250 (8 year olds), $1600 (9 and 10s), $7450 (9-17 year olds, 27 day camps)"
 *   "$119/day"
 *   "varies by camp - $150-$350 / week"
 *   "$199 but scholarships and sliding scale fees are available"
 *   "$445; $150 aftercare"
 *   "Half Day: $285 + $15 materials fee / Full Day: $485 + $15 materials fee"
 *   "$735 for all seven days or $119/day"
 *   "about $1500 for one week"
 *   "free", "TBD", "", etc.
 */

import { PricingUnit } from "@/lib/types";

export interface ParsedPrice {
  label: string;
  amount: number;
  unit: PricingUnit;
  durationWeeks: number | null;
  ageQualifier: string | null;
  discountNotes: string | null;
}

export function parsePricing(raw: string, discountRaw?: string): ParsedPrice[] {
  if (!raw || !raw.trim()) return [];

  const cleaned = raw.trim();
  const lower = cleaned.toLowerCase();

  // Skip unparseable values
  if (lower === "tbd" || lower === "?" || lower === "free") {
    if (lower === "free") {
      return [{ label: "Free", amount: 0, unit: "FLAT", durationWeeks: null, ageQualifier: null, discountNotes: null }];
    }
    return [];
  }

  const results: ParsedPrice[] = [];
  const discountNotes = discountRaw?.trim() || null;

  // Strategy: split on common delimiters, then parse each segment
  // Delimiters: "," followed by "$", ";" , " / " (but not inside prices), " or "
  const segments = splitPriceSegments(cleaned);

  for (const segment of segments) {
    const parsed = parseSinglePriceSegment(segment.trim());
    if (parsed) {
      // Only attach discount notes to the first pricing entry
      if (results.length === 0 && discountNotes) {
        parsed.discountNotes = discountNotes;
      }
      results.push(parsed);
    }
  }

  // If nothing parsed but there's a dollar amount somewhere, try a simple extract
  if (results.length === 0) {
    const simple = extractSimplePrice(cleaned);
    if (simple) {
      if (discountNotes) simple.discountNotes = discountNotes;
      results.push(simple);
    }
  }

  return results;
}

function splitPriceSegments(raw: string): string[] {
  // Split on patterns that indicate separate price tiers:
  //   ", $"  — "$400, $550 Full Day"
  //   "; "   — "$445; $150 aftercare"
  //   " / "  — "$620 per week / $310 for half day"
  //   " or " — "$735 for all seven days or $119/day"

  // Replace delimiters with a unique separator
  let normalized = raw;
  normalized = normalized.replace(/,\s*\$/g, "|||$");
  normalized = normalized.replace(/;\s*\$/g, "|||$");
  normalized = normalized.replace(/;\s+/g, "|||");
  normalized = normalized.replace(/\s+\/\s+\$/g, "|||$");
  normalized = normalized.replace(/\s+\/\s+(?=[A-Z])/g, "|||"); // " / Full Day"
  normalized = normalized.replace(/\s+or\s+\$/gi, "|||$");

  return normalized.split("|||").filter((s) => s.trim());
}

function parseSinglePriceSegment(segment: string): ParsedPrice | null {
  // Extract dollar amount
  const amountMatch = segment.match(/\$[\s]*([\d,]+(?:\.\d{1,2})?)/);
  if (!amountMatch) return null;

  const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
  if (isNaN(amount)) return null;

  const lower = segment.toLowerCase();

  // Determine unit
  const unit = inferUnit(lower);

  // Determine duration for multi-week pricing
  const durationWeeks = inferDurationWeeks(lower);

  // Extract age qualifier
  const ageQualifier = extractAgeQualifier(segment);

  // Build label
  const label = buildLabel(segment, unit, durationWeeks, ageQualifier);

  return {
    label,
    amount,
    unit,
    durationWeeks,
    ageQualifier,
    discountNotes: null,
  };
}

function inferUnit(lower: string): PricingUnit {
  if (lower.includes("/day") || lower.includes("per day") || lower.includes("/daily")) {
    return "PER_DAY";
  }
  if (lower.includes("/session") || lower.includes("per session") || lower.includes("half day") || lower.includes("half-day")) {
    return "PER_SESSION";
  }
  if (lower.includes("/month") || lower.includes("per month")) {
    return "PER_WEEK"; // normalize monthly to weekly equivalent later if needed
  }
  if (
    lower.includes("for one week") ||
    lower.includes("for two week") ||
    lower.includes("for three week") ||
    lower.includes("for 2 week") ||
    lower.includes("for 3 week") ||
    lower.includes("for one month") ||
    lower.includes("27 day") ||
    lower.includes("all summer") ||
    lower.includes("full summer") ||
    lower.includes("for all")
  ) {
    return "PER_CAMP";
  }
  // Default — most Denver camps price per week
  if (lower.includes("/wk") || lower.includes("/week") || lower.includes("per week") || lower.includes("per weekly")) {
    return "PER_WEEK";
  }
  // If it's just a dollar amount with no unit hints, assume per week (most common)
  return "PER_WEEK";
}

function inferDurationWeeks(lower: string): number | null {
  if (lower.includes("one week") || lower.includes("1 week") || lower.includes("1-week")) return 1;
  if (lower.includes("two week") || lower.includes("2 week") || lower.includes("2-week")) return 2;
  if (lower.includes("three week") || lower.includes("3 week") || lower.includes("3-week")) return 3;
  if (lower.includes("four week") || lower.includes("4 week") || lower.includes("one month") || lower.includes("27 day")) return 4;
  if (lower.includes("six week") || lower.includes("6 week")) return 6;
  if (lower.includes("all summer") || lower.includes("full summer")) return 11;
  if (lower.includes("mini camp")) return 1;

  // Try "X days" pattern
  const daysMatch = lower.match(/(\d+)\s*days?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    if (days <= 3) return null; // short camp, not multi-week
    return Math.ceil(days / 5);
  }

  return null;
}

function extractAgeQualifier(segment: string): string | null {
  // Look for parenthetical age info: "(8 year olds)", "(9-17 year olds)"
  const parenMatch = segment.match(/\(([^)]*(?:year|grade|age|old|yr|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th)[^)]*)\)/i);
  if (parenMatch) return parenMatch[1].trim();

  // Look for grade ranges not in parens: "2nd/3rd grade"
  const gradeMatch = segment.match(/((?:\d+(?:st|nd|rd|th)[-\/]?\s*(?:through|to|-)\s*\d+(?:st|nd|rd|th))\s*grade(?:rs?)?)/i);
  if (gradeMatch) return gradeMatch[1].trim();

  return null;
}

function buildLabel(segment: string, unit: PricingUnit, durationWeeks: number | null, ageQualifier: string | null): string {
  const lower = segment.toLowerCase();

  // Try to extract a descriptive label from the segment
  if (lower.includes("full day") || lower.includes("full-day")) return "Full Day";
  if (lower.includes("half day") || lower.includes("half-day")) {
    if (lower.includes("am") || lower.includes("morning")) return "Half Day (AM)";
    if (lower.includes("pm") || lower.includes("afternoon")) return "Half Day (PM)";
    return "Half Day";
  }
  if (lower.includes("aftercare") || lower.includes("extended")) return "Extended Care";
  if (lower.includes("member") && !lower.includes("non")) return "Members";
  if (lower.includes("non-member") || lower.includes("nonmember") || lower.includes("non member")) return "Non-Members";
  if (lower.includes("mini camp")) return "Mini Camp";
  if (lower.includes("all summer") || lower.includes("full summer")) return "Full Summer";
  if (lower.includes("horseback")) return "Horseback Camp";
  if (lower.includes("material")) return "With Materials Fee";

  if (durationWeeks) {
    const weekWord = durationWeeks === 1 ? "1 Week" : `${durationWeeks} Weeks`;
    if (ageQualifier) return `${weekWord} (${ageQualifier})`;
    return weekWord;
  }

  if (unit === "PER_DAY") return "Per Day";
  if (unit === "PER_SESSION") return "Per Session";

  return "Per Week";
}

function extractSimplePrice(raw: string): ParsedPrice | null {
  const match = raw.match(/\$[\s]*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return null;

  const amount = parseFloat(match[1].replace(/,/g, ""));
  if (isNaN(amount)) return null;

  return {
    label: "Per Week",
    amount,
    unit: "PER_WEEK",
    durationWeeks: null,
    ageQualifier: null,
    discountNotes: null,
  };
}
