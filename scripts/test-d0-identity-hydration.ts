import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { computeDiff } from "../lib/ingestion/diff-engine";
import {
  ageGroupDomainIdentity,
  pricingDomainIdentity,
  scheduleDomainIdentity,
  type DomainIdentityResult,
} from "../lib/ingestion/diff-policy";
import { compareRelation, compareValue } from "../lib/ingestion/lookout-diff-adapter";
import type { Camp } from "../lib/types";
import {
  D0_FIXED_NOW,
  RELATION_REPLAY_CASES,
  type RelationMode,
} from "./d0-relation-fixtures";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = D0_FIXED_NOW;

const ageStored = {
  id: "persisted-id",
  campId: "owner-id",
  createdAt: "1999-01-01T00:00:00.000Z",
  label: "Group A",
  minAge: 5,
  maxAge: 7,
  minGrade: null,
  maxGrade: null,
};
const ageCandidate = {
  label: "Group A",
  minAge: 5,
  maxAge: 7,
  minGrade: null,
  maxGrade: null,
};
const scheduleStored = {
  id: "persisted-id",
  campId: "owner-id",
  updatedAt: "1999-01-01T00:00:00.000Z",
  label: "Session A",
  startDate: new Date("2000-06-01T00:00:00.000Z"),
  endDate: "2000-06-05",
  startTime: null,
  endTime: null,
  earlyDropOff: null,
  latePickup: null,
};
const scheduleCandidate = {
  label: "Session A",
  startDate: "2000-06-01",
  endDate: "2000-06-05",
  startTime: null,
  endTime: null,
  earlyDropOff: null,
  latePickup: null,
};
const priceStored = {
  id: "persisted-id",
  campId: "owner-id",
  createdAt: "1999-01-01T00:00:00.000Z",
  label: "Price A",
  amount: "425.00",
  unit: "PER_WEEK",
  durationWeeks: null,
  ageQualifier: null,
  discountNotes: null,
};
const priceCandidate = {
  label: "Price A",
  amount: 425,
  unit: "PER_WEEK",
  durationWeeks: null,
  ageQualifier: null,
  discountNotes: null,
};

function makeCamp(overrides: Partial<Camp> = {}): Camp {
  return {
    id: "camp-id",
    slug: "camp-a",
    name: "Camp A",
    description: "",
    notes: null,
    campType: "SUMMER_DAY",
    category: "OTHER",
    campTypes: ["SUMMER_DAY"],
    categories: ["OTHER"],
    state: null,
    zip: null,
    websiteUrl: "https://example.test/camp-a",
    interestingDetails: null,
    city: "City A",
    region: null,
    communitySlug: "community-a",
    displayName: "Camp A",
    neighborhood: "",
    address: "",
    latitude: null,
    longitude: null,
    lunchIncluded: false,
    registrationOpenDate: null,
    registrationOpenTime: null,
    registrationStatus: "UNKNOWN",
    dataConfidence: "PLACEHOLDER",
    lastVerifiedAt: null,
    sourceType: "SCRAPER",
    sourceUrl: null,
    fieldSources: {},
    ageGroups: [],
    schedules: [],
    pricing: [],
    ...overrides,
  } as Camp;
}

function testStructuralComparison(): void {
  assert.equal(compareValue({ b: { d: 2, c: 1 }, a: 0 }, { a: 0, b: { c: 1, d: 2 } }).changed, false);
  assert.equal(compareValue(["a,b", "c"], ["a", "b,c"]).changed, true);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(compareValue(cyclic, {}).changed, true);
  assert.equal(compareValue(() => undefined, null).changed, true);
  assert.equal(compareValue({ [Symbol("unsupported")]: 1 }, {}).changed, true);
  assert.equal(compareValue(Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => { throw new Error("getter ran"); },
  }), {}).changed, true);
  let getterReads = 0;
  const statefulGetter = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => ++getterReads,
  });
  assert.equal(compareValue(statefulGetter, {}).changed, true);
  assert.equal(getterReads, 0, "canonical encoding must reject accessors without executing them");
  const cyclicOther: Record<string, unknown> = { label: "other" };
  cyclicOther.self = cyclicOther;
  assert.equal(compareRelation([cyclic], [cyclicOther], () => { throw new Error("identity failed"); }).changed, true,
    "canonical failures must fail closed as changed");
}

function testDomainIdentity(): void {
  assert.equal(ageGroupDomainIdentity({ ...ageCandidate, minAge: Infinity }).ok, false);
  assert.equal(ageGroupDomainIdentity({ ...ageCandidate, maxAge: -Infinity }).ok, false);
  assert.equal(scheduleDomainIdentity({ ...scheduleCandidate, startDate: null }).ok, false);
  assert.equal(scheduleDomainIdentity({ ...scheduleCandidate, endDate: undefined }).ok, false);
  assert.equal(scheduleDomainIdentity({ ...scheduleCandidate, startDate: "not-a-date" }).ok, false);
  assert.equal(scheduleDomainIdentity({ ...scheduleCandidate, endDate: "2000-99-99" }).ok, false);
  assert.equal(scheduleDomainIdentity({ ...scheduleCandidate, startDate: new Date(Number.NaN) }).ok, false);
  assert.equal(pricingDomainIdentity({ ...priceCandidate, amount: null }).ok, false);
  assert.equal(pricingDomainIdentity({ ...priceCandidate, unit: null }).ok, false);
  assert.equal(pricingDomainIdentity({ ...priceCandidate, amount: Infinity }).ok, false);
  assert.equal(pricingDomainIdentity({ ...priceCandidate, amount: -Infinity }).ok, false);

  const key = (result: DomainIdentityResult): string => {
    assert.equal(result.ok, true);
    return result.ok ? result.key : "";
  };
  assert.equal(key(ageGroupDomainIdentity(ageStored)), key(ageGroupDomainIdentity(ageCandidate)));
  assert.equal(key(scheduleDomainIdentity(scheduleStored)), key(scheduleDomainIdentity(scheduleCandidate)));
  assert.equal(key(pricingDomainIdentity(priceStored)), key(pricingDomainIdentity(priceCandidate)));

  for (const [identity, value, mutations] of [
    [ageGroupDomainIdentity, ageCandidate, {
      label: "Group B", minAge: 4, maxAge: 8, minGrade: 1, maxGrade: 2,
    }],
    [scheduleDomainIdentity, scheduleCandidate, {
      label: "Session B", startDate: "2000-05-31", endDate: "2000-06-06",
      startTime: "08:00", endTime: "16:00", earlyDropOff: "07:30", latePickup: "17:00",
    }],
    [pricingDomainIdentity, priceCandidate, {
      label: "Price B", amount: 426, unit: "PER_DAY", durationWeeks: 2,
      ageQualifier: "Ages 5+", discountNotes: "Sibling discount",
    }],
  ] as const) {
    for (const [field, changed] of Object.entries(mutations)) {
      assert.notEqual(key(identity(value)), key(identity({ ...value, [field]: changed })), `${field} must remain in domain identity`);
    }
  }

  assert.equal(
    computeDiff(
      makeCamp({ pricing: [{ ...priceStored, amount: "bad-1" }] as unknown as Camp["pricing"] }),
      { pricing: [{ ...priceCandidate, amount: "bad-2" }] } as unknown as Parameters<typeof computeDiff>[1],
      { pricing: 0.9 },
    ).pricing?.mode,
    "update",
    "malformed numeric identities must fail closed instead of suppressing review",
  );
}

function testRelationModesAndSuppression(): void {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    for (const fixture of RELATION_REPLAY_CASES.filter((entry) =>
      entry.fixtureRefs.includes("scripts/test-d0-identity-hydration.ts")
    )) {
      const changes = computeDiff(
        makeCamp({ [fixture.field]: fixture.current } as Partial<Camp>),
        { [fixture.field]: fixture.candidate },
        { [fixture.field]: fixture.confidence },
        {},
        fixture.approvedAt ? { [fixture.field]: { approvedAt: fixture.approvedAt } } : {},
      );
      const mode = (changes[fixture.field]?.mode ?? (fixture.noneReason === "suppressed" ? "suppressed" : "none")) as RelationMode;
      assert.equal(mode, fixture.expectedPost, fixture.id);
    }
  } finally {
    Date.now = originalNow;
  }
}

function testCanonicalHydrationShape(): void {
  const source = fs.readFileSync(path.join(ROOT, "lib/ingestion/crawl-pipeline.ts"), "utf8");
  assert.doesNotMatch(source, /Attach empty arrays for relation fields/);
  assert.doesNotMatch(source, /campsResult\.rows\.map\(c => \(\{[\s\S]*?ageGroups:\s*\[\]/);
  for (const relation of ["CampAgeGroup", "CampSchedule", "CampPricing"]) {
    assert.match(source, new RegExp(`FROM "${relation}"`), `canonical set query must hydrate ${relation}`);
  }
  assert.doesNotMatch(
    source,
    /for \(let di[\s\S]*?pool\.query[\s\S]*?FROM "Camp(?:AgeGroup|Schedule|Pricing)"/,
    "relation hydration must not issue per-entity reads"
  );
}

testStructuralComparison();
testDomainIdentity();
testRelationModesAndSuppression();
testCanonicalHydrationShape();
console.log("D0 identity/hydration fixtures: 4 groups passed; 3 relation families; 18 retained-field mutations; 11 malformed required/non-finite cases");
