/**
 * traverse-schema.ts — the PER-ITEM schema-directed extraction target for
 * CampFit's ingestion pipeline, expressed as @kontourai/traverse
 * `TargetFieldSchema[]`.
 *
 * FULL CUTOVER (owner directive, 2026-07): this replaces the Slice-1b/2b
 * single-entity schema (one page-level record per source). Every field is
 * now nested under a top-level `items[]` array — `items[].name`,
 * `items[].ageGroups[].minAge`, `items[].schedules[].startDate`, etc. — so a
 * listing page with multiple camps/courses extracts as multiple per-camp
 * records instead of collapsing into one page-level record.
 *
 * This is what closes the structural gap the slice-2b adjudication flagged
 * (docs/traverse-adjudication-2026-07.md): ALL FOUR "ambiguous" verdicts
 * traced to the single-entity schema forcing the model to either pick one
 * item's fields (losing the others) or compose a field across multiple
 * items ("cross-band stitching" — e.g. Denver's age range 5–17 pulled minAge
 * from one age band and maxAge from an unrelated one). Traverse 0.4.0 makes
 * this schema-shape possible: when a provider emits an indexed source path
 * against a declared array field (e.g. `"items[2].ageGroups[0].minAge"`
 * against the declared `"items[].ageGroups[].minAge"`), `extract()`
 * normalizes it — rewriting `fieldPath` to the declared form and recording
 * the stripped indices on `ExtractionProposal.pathIndices` (outermost-first:
 * `[2, 0]` here) — instead of dropping it. `lib/ingestion/traverse-item-grouping.ts`
 * consumes `pathIndices[0]` to regroup proposals back into one record per
 * source item, and `pathIndices[1]` to keep a given age band's / schedule's /
 * price row's own fields together (killing cross-band stitching: a camp's
 * ages/dates/price come ONLY from its own item + sub-item group, never a
 * different one). See docs/adr/0003-indexed-path-normalization.md upstream.
 *
 * Traverse itself defines ZERO field names (see its ADR 0001) — every path,
 * enum, and description here is caller-owned. Dotted/bracketed array paths
 * mirror `CampInput`'s shape (adapter.ts): `items[].name` -> one camp's
 * `name`, `items[].ageGroups[].minAge` -> one age band's `minAge` on that
 * camp, etc.
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
 * The per-item camp/program listing schema. Every path is scoped under
 * `items[]` — one array entry per distinct camp/course/program the page
 * lists, however many that is (one, few, or dozens). Scoped to the fields
 * the cutover brief calls out (name, dates, price, ages, location,
 * registration URL) plus the small set of scalars the legacy scrapers used
 * to emit, so parity is still measurable field-for-field.
 */
export const CAMP_TARGET_SCHEMA: TargetFieldSchema[] = [
  {
    path: "items[].name",
    type: "string",
    required: true,
    description: "This specific camp/course/program's own name/title — NOT the page or site title. If the page lists multiple camps, each gets its own items[] entry with its own name.",
  },
  { path: "items[].description", type: "string", description: "A short description of THIS camp/program (not the site/page in general)." },
  {
    path: "items[].category",
    type: "enum",
    enumValues: CAMP_CATEGORY_VALUES,
    description: "The single best-fitting activity category for this specific camp/program.",
  },
  {
    path: "items[].registrationStatus",
    type: "enum",
    enumValues: REGISTRATION_STATUS_VALUES,
    description: "Current registration status for this camp/program if stated; otherwise UNKNOWN.",
  },
  { path: "items[].applicationUrl", type: "string", description: "The registration / sign-up / enroll link URL for this specific camp/program." },
  { path: "items[].websiteUrl", type: "string", description: "This camp/program's own detail/info page URL (its \"Learn more\" link), if different from the registration URL." },
  { path: "items[].city", type: "string", description: "City where this camp/program takes place." },
  { path: "items[].neighborhood", type: "string", description: "Neighborhood or district of this camp/program's location." },
  { path: "items[].address", type: "string", description: "Street address of this camp/program's location." },
  {
    path: "items[].schedules[].startDate",
    type: "date",
    description: "One session's start date (ISO YYYY-MM-DD if possible) for THIS camp. A camp with multiple sessions gets multiple schedules[] entries — do not merge separate sessions into one date range.",
  },
  {
    path: "items[].schedules[].endDate",
    type: "date",
    description: "The SAME session's end date as the paired schedules[].startDate at this index — from the same excerpt, not a different session or the whole-summer season span.",
  },
  {
    path: "items[].ageGroups[].minAge",
    type: "number",
    description: "One age band's minimum age (in years) for THIS camp. A camp with multiple age bands (e.g. separate camps for 5-6 and 7-9) gets multiple ageGroups[] entries — do not compose a single min..max spanning unrelated bands.",
  },
  {
    path: "items[].ageGroups[].maxAge",
    type: "number",
    description: "The SAME age band's maximum age as the paired ageGroups[].minAge at this index — from the same excerpt (e.g. the same \"Ages 7-9\" phrase), never a different band's number.",
  },
  {
    path: "items[].pricing[].amount",
    type: "number",
    description: "One price amount in whole dollars for THIS camp. If member/nonmember or multiple tiers are listed, each gets its own pricing[] entry.",
  },
];

/**
 * Optional per-field hints passed through to the provider prompt. Kept small —
 * the schema `description`s above carry most of the per-item discipline; this
 * adds hints only where the legacy scrapers/parity runs historically tripped
 * (date range parsing, price shape, and the item-grouping discipline itself).
 */
export const CAMP_FIELD_HINTS: Record<string, string> = {
  "items[].schedules[].startDate": "Sessions are often written as a range like 'June 9-13, 2026' — the start is the first date. A whole-summer span like 'June 8 to August 7' describing many sessions is NOT one session — only propose it as a schedule if the page genuinely offers a single continuous multi-week session, not a season overview.",
  "items[].schedules[].endDate": "For a range like 'June 9-13, 2026' the end date is 'June 13, 2026' — pair it with the SAME session's startDate.",
  "items[].ageGroups[].minAge": "Ground each age band in its own excerpt (e.g. 'Ages 7-9') — do not pair a minAge from one excerpt with a maxAge from a different age band's excerpt.",
  "items[].pricing[].amount": "Report the numeric dollar amount only, without the '$' sign or 'per week' suffix.",
  "items[].name": "If the page lists several distinct camps/courses, extract EACH one as its own items[] entry with its own index — do not collapse them into one page-level name like a site title.",
};

/** The declared items[] array field this schema enumerates. Every path is scoped under it. */
export const ITEMS_ARRAY_PREFIX = "items[].";

/**
 * Field paths (relative to one item, i.e. with the `items[].` prefix
 * already stripped) that map to a top-level scalar column on the Camp
 * record. Everything else in {@link CAMP_TARGET_SCHEMA} is a nested/array
 * field (ageGroups, schedules, pricing).
 */
export const SCALAR_SCHEMA_PATHS = [
  "name", "description", "category", "registrationStatus",
  "applicationUrl", "websiteUrl", "city", "neighborhood", "address",
] as const;

export type ScalarSchemaPath = (typeof SCALAR_SCHEMA_PATHS)[number];
