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
 * FIELD-SCHEMA PARITY (traverse-recrawl-cutover, 2026-07, AC5): the schema
 * below now covers the full legacy scalar set `lib/ingestion/llm-provider.ts`'s
 * retired `buildPrompt` used to request (see `lib/ingestion/diff-engine.ts:9-14`'s
 * `SCALAR_FIELDS` — the authoritative legacy field list this schema is kept in
 * sync with) plus `campTypes`/`categories` as per-item ENUM-ARRAY families
 * (`lib/ingestion/diff-engine.ts:18`'s `ENUM_ARRAY_FIELDS`) — distinct from the
 * `ageGroups`/`schedules`/`pricing` nested-ROW families below: these are lists
 * of enum strings on one item, not row objects with multiple sub-fields.
 * Before this cutover pass: 9 scalars / 0 enum-arrays. After: 19 scalars / 2
 * enum-arrays (the 10 added scalars are called out individually below).
 *
 * Traverse itself defines zero field names (its own ADR 0001, referenced
 * above) — every path/enum here is caller-owned, so this is additive schema
 * authoring, not a traverse package change.
 */

import type { TargetFieldSchema } from "@kontourai/traverse";
import type { CampCategory, CampType, RegistrationStatus } from "@/lib/types";

// Kept in sync with lib/types.ts — surfaced to the provider so it proposes
// only valid enum members rather than free text we'd have to reject downstream.
const CAMP_CATEGORY_VALUES: CampCategory[] = [
  "SPORTS", "ARTS", "STEM", "NATURE", "ACADEMIC",
  "MUSIC", "THEATER", "COOKING", "MULTI_ACTIVITY", "OTHER",
];

const CAMP_TYPE_VALUES: CampType[] = [
  "SUMMER_DAY", "SLEEPAWAY", "FAMILY", "VIRTUAL", "WINTER_BREAK", "SCHOOL_BREAK",
];

const REGISTRATION_STATUS_VALUES: RegistrationStatus[] = [
  "OPEN", "FULL", "WAITLIST", "CLOSED", "COMING_SOON", "UNKNOWN",
];

/**
 * The per-item camp/program listing schema. Every path is scoped under
 * `items[]` — one array entry per distinct camp/course/program the page
 * lists, however many that is (one, few, or dozens). Scoped to the fields
 * the cutover brief calls out (name, dates, price, ages, location,
 * registration URL) plus the full set of scalars the legacy
 * `buildPrompt`-based extractor used to emit, so parity is measurable
 * field-for-field (AC5).
 */
export const CAMP_TARGET_SCHEMA: TargetFieldSchema[] = [
  {
    path: "items[].name",
    type: "string",
    required: true,
    description: "This specific camp/course/program's own name/title — NOT the page or site title. If the page lists multiple camps, each gets its own items[] entry with its own name.",
  },
  {
    path: "items[].organizationName",
    type: "string",
    description: "The hosting school, museum, nonprofit, or organization operating THIS camp/program, if the page states it separately from the camp's own name.",
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
    description: "Current registration status for this camp/program if stated; otherwise UNKNOWN. COMING_SOON = registration opens in the future; OPEN = currently open; FULL = at capacity; WAITLIST = full but waitlisting; CLOSED = registration period ended; UNKNOWN = no clear information.",
  },
  {
    path: "items[].registrationOpenDate",
    type: "date",
    description: "The date THIS camp/program's registration opens, as YYYY-MM-DD. Only set if an explicit date is stated on the page.",
  },
  {
    path: "items[].registrationCloseDate",
    type: "date",
    description: "The date THIS camp/program's registration closes, or the deadline to register, as YYYY-MM-DD. Only set if explicitly stated.",
  },
  {
    path: "items[].lunchIncluded",
    type: "boolean",
    description: "True only if the page explicitly states lunch/meals are included with THIS camp/program; false if explicitly stated as NOT included. Do not guess if unmentioned.",
  },
  { path: "items[].applicationUrl", type: "string", description: "The registration / sign-up / enroll link URL for this specific camp/program." },
  { path: "items[].websiteUrl", type: "string", description: "This camp/program's own detail/info page URL (its \"Learn more\" link), if different from the registration URL." },
  {
    path: "items[].contactEmail",
    type: "string",
    description: "The best camp-specific or organization contact email listed on the page for THIS camp/program.",
  },
  {
    path: "items[].contactPhone",
    type: "string",
    description: "The best camp-specific or organization contact phone number listed on the page for THIS camp/program.",
  },
  {
    path: "items[].socialLinks",
    type: "object",
    description: "An object of explicit social profile URLs found on the page for THIS camp/program's organization, e.g. {\"instagram\":\"https://...\",\"facebook\":\"https://...\"} — only platforms explicitly linked, never guessed.",
  },
  { path: "items[].city", type: "string", description: "City where this camp/program takes place. Must be a real city name (e.g. \"Arvada\", \"Denver\") — NOT a state name." },
  { path: "items[].neighborhood", type: "string", description: "Neighborhood or district of this camp/program's location." },
  { path: "items[].address", type: "string", description: "Street address of this camp/program's location. Must be a street address only (e.g. \"4001 E Iliff Ave\") — NOT a neighborhood or park name." },
  {
    path: "items[].state",
    type: "string",
    description: "A 2-letter US state abbreviation (e.g. \"CO\") for THIS camp/program's location, if found on the page.",
  },
  {
    path: "items[].zip",
    type: "string",
    description: "A 5-digit US zip code for THIS camp/program's location, if found on the page.",
  },
  {
    path: "items[].interestingDetails",
    type: "string",
    description: "Any additional notable detail about THIS camp/program worth surfacing to a parent (e.g. a unique offering, notable instructor, or amenity) that isn't captured by the other fields.",
  },
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
  {
    path: "items[].campTypes[]",
    type: "enum",
    enumValues: CAMP_TYPE_VALUES,
    description: "One camp-type tag that applies to THIS camp/program — list every tag that applies as its own campTypes[] entry (not a single composed value). SUMMER_DAY = drop-off day camp during summer, SLEEPAWAY = overnight/residential, FAMILY = parents attend with kids, VIRTUAL = fully online, WINTER_BREAK = runs during winter/holiday school break, SCHOOL_BREAK = spring break, fall break, or other non-summer school holiday.",
  },
  {
    path: "items[].categories[]",
    type: "enum",
    enumValues: CAMP_CATEGORY_VALUES,
    description: "One activity category that applies to THIS camp/program — list EVERY category that applies as its own categories[] entry, not just the single best fit (unlike the singular items[].category field above).",
  },
];

/**
 * Optional per-field hints passed through to the provider prompt. Kept small —
 * the schema `description`s above carry most of the per-item discipline; this
 * adds hints only where the legacy scrapers/parity runs historically tripped
 * (date range parsing, price shape, the item-grouping discipline itself, and
 * the field-parity additions below, mirrored from the retired `buildPrompt`'s
 * per-field prompt rules).
 */
export const CAMP_FIELD_HINTS: Record<string, string> = {
  "items[].schedules[].startDate": "Sessions are often written as a range like 'June 9-13, 2026' — the start is the first date. A whole-summer span like 'June 8 to August 7' describing many sessions is NOT one session — only propose it as a schedule if the page genuinely offers a single continuous multi-week session, not a season overview.",
  "items[].schedules[].endDate": "For a range like 'June 9-13, 2026' the end date is 'June 13, 2026' — pair it with the SAME session's startDate.",
  "items[].ageGroups[].minAge": "Ground each age band in its own excerpt (e.g. 'Ages 7-9') — do not pair a minAge from one excerpt with a maxAge from a different age band's excerpt.",
  "items[].pricing[].amount": "Report the numeric dollar amount only, without the '$' sign or 'per week' suffix.",
  "items[].name": "If the page lists several distinct camps/courses, extract EACH one as its own items[] entry with its own index — do not collapse them into one page-level name like a site title.",
  "items[].state": "Must be a 2-letter US state abbreviation only (e.g. 'CO'), not a full state name.",
  "items[].zip": "Must be a 5-digit US zip code only.",
  "items[].registrationOpenDate": "Only set if an explicit open/start date for registration is stated — do not infer from the camp's own session dates.",
  "items[].registrationCloseDate": "Only set if an explicit close date or registration deadline is stated — do not infer from the camp's own session dates.",
  "items[].lunchIncluded": "Only set true/false when the page explicitly says whether lunch/meals are included — leave unset if not mentioned.",
  "items[].socialLinks": "Only include platforms with an explicit URL on the page — never guess a handle or platform that isn't linked.",
  "items[].campTypes[]": "List every camp-type tag that genuinely applies to THIS camp/program — most camps have exactly one, but some (e.g. a day camp that also offers an overnight option) may have more than one.",
  "items[].categories[]": "List every activity category that applies to THIS camp/program, not just the single best fit — a multi-activity camp may span several categories at once.",
};

/** The declared items[] array field this schema enumerates. Every path is scoped under it. */
export const ITEMS_ARRAY_PREFIX = "items[].";

/**
 * Field paths (relative to one item, i.e. with the `items[].` prefix
 * already stripped) that map to a top-level scalar column on the Camp
 * record. Everything else in {@link CAMP_TARGET_SCHEMA} is a nested/array
 * field (ageGroups, schedules, pricing, campTypes, categories).
 */
export const SCALAR_SCHEMA_PATHS = [
  "name", "organizationName", "description", "category", "registrationStatus",
  "registrationOpenDate", "registrationCloseDate", "lunchIncluded",
  "applicationUrl", "websiteUrl", "contactEmail", "contactPhone", "socialLinks",
  "city", "neighborhood", "address", "state", "zip", "interestingDetails",
] as const;

export type ScalarSchemaPath = (typeof SCALAR_SCHEMA_PATHS)[number];

/**
 * Field paths (relative to one item) for the enum-ARRAY families — lists of
 * enum strings on one item (`campTypes`, `categories`), distinct from the
 * nested-ROW families (`ageGroups`, `schedules`, `pricing`, each a list of
 * multi-field row objects). Mirrors `diff-engine.ts`'s `ENUM_ARRAY_FIELDS`.
 */
export const ENUM_ARRAY_SCHEMA_PATHS = ["campTypes", "categories"] as const;

export type EnumArraySchemaPath = (typeof ENUM_ARRAY_SCHEMA_PATHS)[number];
