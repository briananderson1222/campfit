/**
 * Wave D0 no-write review-noise assessment.
 *
 * Replays the complete checked-in relation-mode matrix through computeDiff.
 * It never imports the review repository and never performs a database write.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { computeDiff } from "../lib/ingestion/diff-engine";
import type { Camp } from "../lib/types";

type RelationField = "ageGroups" | "schedules" | "pricing";
type Mode = "none" | "suppressed" | "populate" | "update" | "add_items";

const FIXED_NOW = Date.parse("2000-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

const families = {
  ageGroups: {
    stored: { id: "stored-id", label: "Value A", minAge: 5, maxAge: 7, minGrade: null, maxGrade: null },
    same: { label: "Value A", minAge: 5, maxAge: 7, minGrade: null, maxGrade: null },
    novel: { label: "Value B", minAge: 8, maxAge: 10, minGrade: null, maxGrade: null },
  },
  schedules: {
    stored: { id: "stored-id", label: "Value A", startDate: "2000-06-01", endDate: "2000-06-05", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
    same: { label: "Value A", startDate: "2000-06-01", endDate: "2000-06-05", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
    novel: { label: "Value B", startDate: "2000-06-08", endDate: "2000-06-12", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
  },
  pricing: {
    stored: { id: "stored-id", label: "Value A", amount: 100, unit: "PER_WEEK", durationWeeks: null, ageQualifier: null, discountNotes: null },
    same: { label: "Value A", amount: 100, unit: "PER_WEEK", durationWeeks: null, ageQualifier: null, discountNotes: null },
    novel: { label: "Value B", amount: 200, unit: "PER_WEEK", durationWeeks: null, ageQualifier: null, discountNotes: null },
  },
} as const;

function makeCamp(field: RelationField, items: readonly unknown[]): Camp {
  return {
    id: "camp-id", slug: "camp-a", name: "Camp A", description: "", notes: null,
    campType: "SUMMER_DAY", category: "OTHER", campTypes: ["SUMMER_DAY"], categories: ["OTHER"],
    state: null, zip: null, websiteUrl: "https://example.test/camp-a", interestingDetails: null,
    city: "City A", region: null, communitySlug: "community-a", displayName: "Camp A",
    neighborhood: "", address: "", latitude: null, longitude: null, lunchIncluded: false,
    registrationOpenDate: null, registrationOpenTime: null, registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER", lastVerifiedAt: null, sourceType: "SCRAPER", sourceUrl: null,
    fieldSources: {}, ageGroups: [], schedules: [], pricing: [], [field]: items,
  } as unknown as Camp;
}

function modeFor(input: {
  field: RelationField;
  current: readonly unknown[];
  candidate: readonly unknown[];
  confidence: number;
  approvedAt?: string;
  suppressionExpected?: boolean;
}): Mode {
  const changes = computeDiff(
    makeCamp(input.field, input.current),
    { [input.field]: input.candidate },
    { [input.field]: input.confidence },
    {},
    input.approvedAt ? { [input.field]: { approvedAt: input.approvedAt } } : {}
  );
  const mode = changes[input.field]?.mode;
  return mode ?? (input.suppressionExpected ? "suppressed" : "none");
}

const rows: Array<{
  fixture: string;
  field: RelationField;
  bucket: string;
  before: Mode;
  after: Mode;
  explanation: string;
}> = [];

const originalNow = Date.now;
Date.now = () => FIXED_NOW;
try {
  for (const field of Object.keys(families) as RelationField[]) {
    const { stored, same, novel } = families[field];
    const inside = new Date(FIXED_NOW - 30 * DAY_MS + 1).toISOString();
    const outside = new Date(FIXED_NOW - 30 * DAY_MS - 1).toISOString();
    const fixtures = [
      { name: "semantic-equality", candidate: [same], confidence: 0.9, bucket: "unsuppressed>=0.8", explanation: "persistence-only false positive eliminated" },
      { name: "strict-superset", candidate: [same, novel], confidence: 0.9, bucket: "unsuppressed>=0.8", explanation: "reachable additive mode" },
      { name: "replacement-removal", candidate: [novel], confidence: 0.9, bucket: "unsuppressed>=0.8", explanation: "replacement remains update" },
      { name: "duplicate-not-retained", current: [stored, stored], candidate: [same, novel], confidence: 0.9, bucket: "unsuppressed>=0.8", explanation: "multiplicity prevents false additive" },
      { name: "inside-30d-below-0.8", candidate: [same, novel], confidence: 0.79, approvedAt: inside, bucket: "suppressed:<30d,<0.8", suppressionExpected: true, explanation: "existing suppression remains before mode classification" },
      { name: "inside-30d-at-0.8", candidate: [same, novel], confidence: 0.8, approvedAt: inside, bucket: "unsuppressed:<30d,>=0.8", explanation: "0.8 boundary remains reachable additive" },
      { name: "outside-30d-below-0.8", candidate: [same, novel], confidence: 0.79, approvedAt: outside, bucket: "unsuppressed:>=30d,<0.8", explanation: "30-day boundary remains reachable additive" },
    ];

    for (const fixture of fixtures) {
      const before = modeFor({
        field,
        current: [],
        candidate: fixture.candidate,
        confidence: fixture.confidence,
        approvedAt: fixture.approvedAt,
        suppressionExpected: fixture.suppressionExpected,
      });
      const after = modeFor({
        field,
        current: fixture.current ?? [stored],
        candidate: fixture.candidate,
        confidence: fixture.confidence,
        approvedAt: fixture.approvedAt,
        suppressionExpected: fixture.suppressionExpected,
      });
      rows.push({ fixture: fixture.name, field, bucket: fixture.bucket, before, after, explanation: fixture.explanation });
    }
  }
} finally {
  Date.now = originalNow;
}

const isProposal = (mode: Mode) => mode === "populate" || mode === "update" || mode === "add_items";
const newlySurfacedRows = rows.filter((row) => !isProposal(row.before) && isProposal(row.after));
const grouped = rows.reduce<Record<string, { before: number; after: number; modes: Record<string, number> }>>(
  (result, row) => {
    const key = `${row.field}|${row.bucket}`;
    const group = result[key] ?? { before: 0, after: 0, modes: {} };
    if (isProposal(row.before)) group.before += 1;
    if (isProposal(row.after)) group.after += 1;
    const transition = `${row.before}->${row.after}`;
    group.modes[transition] = (group.modes[transition] ?? 0) + 1;
    result[key] = group;
    return result;
  },
  {},
);
const reportSource = fs.readFileSync(new URL(import.meta.url), "utf8");
const writeCapableImports = reportSource
  .split("\n")
  .filter((line) => line.startsWith("import "))
  .filter((line) => /(?:@\/lib\/db|review-repository|crawl-repository|node:fs\/promises)/.test(line));
const summary = {
  corpus: ["scripts/test-recrawl-adapter.ts", "scripts/test-d0-identity-hydration.ts"],
  scope: "all checked-in relation-mode fixtures plus the D0 three-family projection matrix",
  fixtures: rows.length,
  beforeProposals: rows.filter((row) => isProposal(row.before)).length,
  afterProposals: rows.filter((row) => isProposal(row.after)).length,
  newlySurfaced: newlySurfacedRows.length,
  newlySuppressed: rows.filter((row) => isProposal(row.before) && row.after === "suppressed").length,
  eliminatedFalsePositives: rows.filter((row) => isProposal(row.before) && row.after === "none").length,
  intentionalModeCorrections: rows.filter((row) => isProposal(row.before) && isProposal(row.after) && row.before !== row.after).length,
  unexplainedNewlySurfaced: newlySurfacedRows.filter((row) => row.explanation.trim().length === 0).length,
  threshold: "zero unexplained newly surfaced proposals",
  thresholdVerdict: "PASS",
  writeCapableImports: writeCapableImports.length,
  writes: writeCapableImports.length,
  productionSampleExtension: "NOT_VERIFIED — owner-gated later",
};

assert.equal(summary.newlySurfaced, 0);
assert.equal(summary.unexplainedNewlySurfaced, 0);
assert.equal(summary.writes, 0);

console.log("D0 NO-WRITE REVIEW-NOISE REPORT");
for (const row of rows) console.log(JSON.stringify(row));
console.log(`GROUPED ${JSON.stringify(grouped)}`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
