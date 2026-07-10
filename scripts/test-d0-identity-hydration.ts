import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { computeDiff } from "../lib/ingestion/diff-engine";
import {
  ageGroupDomainIdentity,
  canonicalValueKey,
  outerArrayChange,
  pricingDomainIdentity,
  scheduleDomainIdentity,
} from "../lib/ingestion/diff-kernel";
import type { Camp } from "../lib/types";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FIXED_NOW = Date.parse("2000-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

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

function testCanonicalEncoding(): void {
  const key = (value: unknown) => {
    const result = canonicalValueKey(value);
    assert.equal(result.ok, true);
    return result.ok ? result.key : "";
  };

  assert.notEqual(key({ a: undefined }), key({}));
  assert.notEqual(key([undefined]), key([null]));
  assert.notEqual(key(new Array(1)), key([undefined]));
  assert.notEqual(key(Number.NaN), key(null));
  assert.notEqual(key(Number.POSITIVE_INFINITY), key(null));
  assert.notEqual(key(-0), key(0));
  assert.equal(key({ b: { d: 2, c: 1 }, a: 0 }), key({ a: 0, b: { c: 1, d: 2 } }));
  assert.notEqual(key(["a,b", "c"]), key(["a", "b,c"]));

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(canonicalValueKey(cyclic).ok, false);
  assert.equal(canonicalValueKey(() => undefined).ok, false);
  assert.equal(canonicalValueKey({ [Symbol("unsupported")]: 1 }).ok, false);
  assert.equal(canonicalValueKey(Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => { throw new Error("getter ran"); },
  })).ok, false);
  let getterReads = 0;
  const statefulGetter = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => ++getterReads,
  });
  assert.equal(canonicalValueKey(statefulGetter).ok, false);
  assert.equal(getterReads, 0, "canonical encoding must reject accessors without executing them");
  const cyclicOther: Record<string, unknown> = { label: "other" };
  cyclicOther.self = cyclicOther;
  assert.notEqual(outerArrayChange([cyclic], [cyclicOther]), null, "canonical failures must fail closed as changed");
}

function testDomainIdentity(): void {
  assert.equal(ageGroupDomainIdentity(ageStored), ageGroupDomainIdentity(ageCandidate));
  assert.equal(scheduleDomainIdentity(scheduleStored), scheduleDomainIdentity(scheduleCandidate));
  assert.equal(pricingDomainIdentity(priceStored), pricingDomainIdentity(priceCandidate));

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
      assert.notEqual(identity(value), identity({ ...value, [field]: changed }), `${field} must remain in domain identity`);
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
  const cases = [
    ["ageGroups", ageStored, ageCandidate, { ...ageCandidate, label: "Group B" }],
    ["schedules", scheduleStored, scheduleCandidate, { ...scheduleCandidate, label: "Session B" }],
    ["pricing", priceStored, priceCandidate, { ...priceCandidate, label: "Price B" }],
  ] as const;

  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    for (const [field, stored, same, novel] of cases) {
      assert.deepEqual(
        computeDiff(makeCamp({ [field]: [stored] } as Partial<Camp>), { [field]: [same] }, { [field]: 0.9 }),
        {},
        `${field}: persistence-only differences must not propose a review`
      );
      assert.equal(
        computeDiff(makeCamp({ [field]: [stored] } as Partial<Camp>), { [field]: [same, novel] }, { [field]: 0.9 })[field]?.mode,
        "add_items",
        `${field}: stored same item plus one novel item must be additive`
      );
      assert.equal(
        computeDiff(makeCamp({ [field]: [stored] } as Partial<Camp>), { [field]: [novel] }, { [field]: 0.9 })[field]?.mode,
        "update",
        `${field}: replacement/removal remains update`
      );
      assert.equal(
        computeDiff(makeCamp({ [field]: [stored, stored] } as Partial<Camp>), { [field]: [same, novel] }, { [field]: 0.9 })[field]?.mode,
        "update",
        `${field}: duplicate multiplicity must be retained`
      );

      const inside30Days = new Date(FIXED_NOW - 30 * DAY_MS + 1).toISOString();
      const outside30Days = new Date(FIXED_NOW - 30 * DAY_MS - 1).toISOString();
      assert.deepEqual(
        computeDiff(makeCamp({ [field]: [stored] } as Partial<Camp>), { [field]: [same, novel] }, { [field]: 0.79 }, {}, { [field]: { approvedAt: inside30Days } }),
        {},
        `${field}: additive change below 0.8 inside 30 days stays suppressed`
      );
      assert.equal(
        computeDiff(makeCamp({ [field]: [stored] } as Partial<Camp>), { [field]: [same, novel] }, { [field]: 0.8 }, {}, { [field]: { approvedAt: inside30Days } })[field]?.mode,
        "add_items",
        `${field}: additive change at 0.8 inside 30 days surfaces`
      );
      assert.equal(
        computeDiff(makeCamp({ [field]: [stored] } as Partial<Camp>), { [field]: [same, novel] }, { [field]: 0.79 }, {}, { [field]: { approvedAt: outside30Days } })[field]?.mode,
        "add_items",
        `${field}: additive change outside 30 days surfaces`
      );
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

testCanonicalEncoding();
testDomainIdentity();
testRelationModesAndSuppression();
testCanonicalHydrationShape();
console.log("D0 identity/hydration fixtures: 4 groups passed; 3 relation families; 18 retained-field mutations");
