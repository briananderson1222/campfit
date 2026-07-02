/**
 * traverse-schema.ts — the schema-directed extraction target for CampFit's
 * scraped camp/program listing shape, expressed as @kontourai/traverse
 * `TargetFieldSchema[]`.
 *
 * PILOT (Traverse Slice 1b): this is the schema the traverse extractor is
 * pointed at instead of hand-written CSS selectors. The field paths below are
 * derived directly from the real scraper output type (`CampInput` in
 * ./adapter.ts) — the same fields the legacy selector scrapers
 * (lib/ingestion/scrapers/*.ts) populate: name, description, category, the
 * registration URL, location, session dates, age ranges, and price.
 *
 * Traverse itself defines ZERO field names (see its ADR 0001) — every path,
 * enum, and description here is caller-owned. Dotted array paths like
 * "schedules[].startDate" mirror `CampInput.schedules[].startDate`; traverse
 * treats the path as an opaque, caller-owned key and the pilot's mapping layer
 * (traverse-extractor.ts) is what knows how to route each path into a
 * CampChangeProposal.
 */

import type { TargetFieldSchema } from "@kontourai/traverse";
import type { CampCategory, RegistrationStatus } from "@/lib/types";

// Kept in sync with lib/types.ts — surfaced to the provider so it proposes
// only valid enum members rather than free text we'd have to reject downstream.
const CAMP_CATEGORY_VALUES: CampCategory[] = [
  "SPORTS", "ARTS", "STEM", "NATURE", "ACADEMIC",
  "MUSIC", "THEATER", "COOKING", "MULTI_ACTIVITY", "OTHER",
];

const REGISTRATION_STATUS_VALUES: RegistrationStatus[] = [
  "OPEN", "FULL", "WAITLIST", "CLOSED", "COMING_SOON", "UNKNOWN",
];

/**
 * The camp/program listing schema. Scoped to the fields the pilot brief calls
 * out (name, dates, price, ages, location, registration URL) plus the small
 * set of scalars the legacy scrapers already emit, so parity is measurable
 * field-for-field against them.
 */
export const CAMP_TARGET_SCHEMA: TargetFieldSchema[] = [
  { path: "name", type: "string", required: true, description: "The camp or program's name/title." },
  { path: "description", type: "string", description: "A short description of the camp or program." },
  {
    path: "category",
    type: "enum",
    enumValues: CAMP_CATEGORY_VALUES,
    description: "The single best-fitting activity category for this camp.",
  },
  {
    path: "registrationStatus",
    type: "enum",
    enumValues: REGISTRATION_STATUS_VALUES,
    description: "Current registration status if stated on the page; otherwise UNKNOWN.",
  },
  { path: "applicationUrl", type: "string", description: "The registration / sign-up / enroll link URL." },
  { path: "websiteUrl", type: "string", description: "The camp or program's own detail/info page URL." },
  { path: "city", type: "string", description: "City where the camp takes place." },
  { path: "neighborhood", type: "string", description: "Neighborhood or district of the camp location." },
  { path: "address", type: "string", description: "Street address of the camp location." },
  { path: "schedules[].startDate", type: "date", description: "Session start date (ISO YYYY-MM-DD if possible)." },
  { path: "schedules[].endDate", type: "date", description: "Session end date (ISO YYYY-MM-DD if possible)." },
  { path: "ageGroups[].minAge", type: "number", description: "Minimum age (in years) the camp serves." },
  { path: "ageGroups[].maxAge", type: "number", description: "Maximum age (in years) the camp serves." },
  { path: "pricing[].amount", type: "number", description: "Price amount in whole dollars." },
];

/**
 * Optional per-field hints passed through to the provider prompt. Kept small —
 * the pilot leans on the schema `description`s above and adds hints only where
 * the legacy scrapers historically tripped (date range parsing, price shape).
 */
export const CAMP_FIELD_HINTS: Record<string, string> = {
  "schedules[].startDate": "Sessions are often written as a range like 'June 9-13, 2026' — the start is the first date.",
  "schedules[].endDate": "For a range like 'June 9-13, 2026' the end date is 'June 13, 2026'.",
  "pricing[].amount": "Report the numeric dollar amount only, without the '$' sign or 'per week' suffix.",
};

/** Field paths that map to a top-level scalar column on the Camp record. */
export const SCALAR_SCHEMA_PATHS = [
  "name", "description", "category", "registrationStatus",
  "applicationUrl", "websiteUrl", "city", "neighborhood", "address",
] as const;

export type ScalarSchemaPath = (typeof SCALAR_SCHEMA_PATHS)[number];
