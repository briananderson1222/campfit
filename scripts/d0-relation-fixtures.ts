export type RelationField = "ageGroups" | "schedules" | "pricing";
export type RelationMode = "none" | "suppressed" | "populate" | "update" | "add_items";

export interface RelationReplayCase {
  id: string;
  field: RelationField;
  current: readonly unknown[];
  candidate: readonly unknown[];
  confidence: number;
  approvedAt?: string;
  noneReason?: "equality" | "suppressed";
  bucket: string;
  expectedPost: RelationMode;
  fixtureRefs: readonly string[];
}

export const D0_FIXED_NOW = Date.parse("2000-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;
const inside30Days = new Date(D0_FIXED_NOW - 30 * DAY_MS + 1).toISOString();
const outside30Days = new Date(D0_FIXED_NOW - 30 * DAY_MS - 1).toISOString();

export const RECRAWL_PRICE_A = {
  id: "price-a", label: "Standard week", amount: 425, unit: "PER_WEEK" as const,
  durationWeeks: null, ageQualifier: null, discountNotes: null,
};
export const RECRAWL_PRICE_B = {
  id: "price-b", label: "Extended week", amount: 525, unit: "PER_WEEK" as const,
  durationWeeks: null, ageQualifier: null, discountNotes: null,
};
export const RECRAWL_PRICE_C = {
  id: "price-c", label: "Holiday week", amount: 475, unit: "PER_WEEK" as const,
  durationWeeks: null, ageQualifier: null, discountNotes: null,
};
export const RECRAWL_EXTRACTED_PRICE_A = {
  label: RECRAWL_PRICE_A.label, amount: RECRAWL_PRICE_A.amount, unit: RECRAWL_PRICE_A.unit,
  durationWeeks: null, ageQualifier: null, discountNotes: null,
};
export const RECRAWL_EXTRACTED_PRICE_B = {
  label: RECRAWL_PRICE_B.label, amount: RECRAWL_PRICE_B.amount, unit: RECRAWL_PRICE_B.unit,
  durationWeeks: null, ageQualifier: null, discountNotes: null,
};

export const RELATION_FAMILIES = {
  ageGroups: {
    stored: { id: "stored-id", campId: "owner-id", createdAt: "1999-01-01T00:00:00.000Z", label: "Value A", minAge: 5, maxAge: 7, minGrade: null, maxGrade: null },
    same: { label: "Value A", minAge: 5, maxAge: 7, minGrade: null, maxGrade: null },
    novel: { label: "Value B", minAge: 8, maxAge: 10, minGrade: null, maxGrade: null },
  },
  schedules: {
    stored: { id: "stored-id", campId: "owner-id", updatedAt: "1999-01-01T00:00:00.000Z", label: "Value A", startDate: "2000-06-01", endDate: "2000-06-05", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
    same: { label: "Value A", startDate: "2000-06-01", endDate: "2000-06-05", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
    novel: { label: "Value B", startDate: "2000-06-08", endDate: "2000-06-12", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
  },
  pricing: {
    stored: { id: "stored-id", campId: "owner-id", createdAt: "1999-01-01T00:00:00.000Z", label: "Value A", amount: 100, unit: "PER_WEEK", durationWeeks: null, ageQualifier: null, discountNotes: null },
    same: { label: "Value A", amount: 100, unit: "PER_WEEK", durationWeeks: null, ageQualifier: null, discountNotes: null },
    novel: { label: "Value B", amount: 200, unit: "PER_WEEK", durationWeeks: null, ageQualifier: null, discountNotes: null },
  },
} as const;

const d0Matrix = (Object.keys(RELATION_FAMILIES) as RelationField[]).flatMap((field): RelationReplayCase[] => {
  const { stored, same, novel } = RELATION_FAMILIES[field];
  const refs = ["scripts/test-d0-identity-hydration.ts"];
  return [
    { id: `${field}:semantic-equality`, field, current: [stored], candidate: [same], confidence: 0.9, noneReason: "equality", bucket: "unsuppressed>=0.8", expectedPost: "none", fixtureRefs: [...refs] },
    { id: `${field}:strict-superset`, field, current: [stored], candidate: [same, novel], confidence: 0.9, bucket: "unsuppressed>=0.8", expectedPost: "add_items", fixtureRefs: [...refs] },
    { id: `${field}:replacement-removal`, field, current: [stored], candidate: [novel], confidence: 0.9, bucket: "unsuppressed>=0.8", expectedPost: "update", fixtureRefs: [...refs] },
    { id: `${field}:duplicate-not-retained`, field, current: [stored, stored], candidate: [same, novel], confidence: 0.9, bucket: "unsuppressed>=0.8", expectedPost: "update", fixtureRefs: [...refs] },
    { id: `${field}:inside-30d-below-0.8`, field, current: [stored], candidate: [same, novel], confidence: 0.79, approvedAt: inside30Days, noneReason: "suppressed", bucket: "suppressed:<30d,<0.8", expectedPost: "suppressed", fixtureRefs: [...refs] },
    { id: `${field}:inside-30d-at-0.8`, field, current: [stored], candidate: [same, novel], confidence: 0.8, approvedAt: inside30Days, bucket: "unsuppressed:<30d,>=0.8", expectedPost: "add_items", fixtureRefs: [...refs] },
    { id: `${field}:outside-30d-below-0.8`, field, current: [stored], candidate: [same, novel], confidence: 0.79, approvedAt: outside30Days, bucket: "unsuppressed:>=30d,<0.8", expectedPost: "add_items", fixtureRefs: [...refs] },
  ];
});

const recrawlOnly: RelationReplayCase[] = [
  { id: "pricing:recrawl-strict-superset", field: "pricing", current: [RECRAWL_PRICE_A], candidate: [RECRAWL_PRICE_A, RECRAWL_PRICE_B], confidence: 0.91, bucket: "unsuppressed>=0.8", expectedPost: "add_items", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-replacement", field: "pricing", current: [RECRAWL_PRICE_A, RECRAWL_PRICE_B], candidate: [RECRAWL_PRICE_A, RECRAWL_PRICE_C], confidence: 0.92, bucket: "unsuppressed>=0.8", expectedPost: "update", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-populate", field: "pricing", current: [], candidate: [RECRAWL_PRICE_A], confidence: 0.93, bucket: "unsuppressed>=0.8", expectedPost: "populate", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-idless-populate", field: "pricing", current: [], candidate: [RECRAWL_EXTRACTED_PRICE_A], confidence: 0.93, bucket: "unsuppressed>=0.8", expectedPost: "populate", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-hydrated-idless-superset", field: "pricing", current: [RECRAWL_PRICE_A], candidate: [RECRAWL_EXTRACTED_PRICE_A, RECRAWL_EXTRACTED_PRICE_B], confidence: 0.93, bucket: "unsuppressed>=0.8", expectedPost: "add_items", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-reorder", field: "pricing", current: [RECRAWL_PRICE_A, RECRAWL_PRICE_B], candidate: [RECRAWL_PRICE_B, RECRAWL_PRICE_A], confidence: 0.94, noneReason: "equality", bucket: "unsuppressed>=0.8", expectedPost: "none", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-duplicate-only-growth", field: "pricing", current: [RECRAWL_PRICE_A], candidate: [RECRAWL_PRICE_A, RECRAWL_PRICE_A], confidence: 0.95, bucket: "unsuppressed>=0.8", expectedPost: "update", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-duplicate-not-retained", field: "pricing", current: [RECRAWL_PRICE_A, RECRAWL_PRICE_A], candidate: [RECRAWL_PRICE_A, RECRAWL_PRICE_B, RECRAWL_PRICE_C], confidence: 0.96, bucket: "unsuppressed>=0.8", expectedPost: "update", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
  { id: "pricing:recrawl-duplicate-retained", field: "pricing", current: [RECRAWL_PRICE_A, RECRAWL_PRICE_A], candidate: [RECRAWL_PRICE_A, RECRAWL_PRICE_A, RECRAWL_PRICE_B], confidence: 0.97, bucket: "unsuppressed>=0.8", expectedPost: "add_items", fixtureRefs: ["scripts/test-recrawl-adapter.ts"] },
];

export const RELATION_REPLAY_CASES: readonly RelationReplayCase[] = [...d0Matrix, ...recrawlOnly];

export const CLASSIFIER_OUT_OF_CORPUS = {
  "scripts/test-d0-identity-hydration.ts": [
    "canonical encoder collision/error checks",
    "typed malformed-domain identity checks",
    "18 retained-field identity mutation checks",
    "crawl-pipeline source-shape/no-N+1 guard",
  ],
  "scripts/test-recrawl-adapter.ts": [
    "mixed scalar/enum/relation byte-serialization assertion (exact relation classifier leg is pricing:recrawl-strict-superset)",
    "scalar 0.3 and scalar suppression characterization",
    "HTML extraction, item selection, route wiring, provider, snapshot, render, and freshness checks",
  ],
} as const;
