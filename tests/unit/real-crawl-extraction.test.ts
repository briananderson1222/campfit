/**
 * What a real crawl's extraction produced, replayed through the real Relay
 * extraction provider (tests/fixtures/real-crawl/replay.ts). Only the model
 * runtime is a stand-in.
 */
import { describe, expect, it } from "vitest";
import { buildRelayExtractionSchema } from "@kontourai/traverse/relay";

import { CAMP_FIELD_HINTS, CAMP_TARGET_SCHEMA } from "@/lib/ingestion/traverse-schema";
import { runTraverseExtraction } from "@/lib/ingestion/traverse-extractor";
import { assembleItems } from "@/lib/ingestion/traverse-item-grouping";
import { assembledItemToDiffInputs } from "@/lib/ingestion/traverse-diff-inputs";
import { createReplayProvider, listingHtml, loadModelOutput } from "../fixtures/real-crawl/replay";

const SOURCE_REF = "https://pineridge.example/dates-rates";

async function extractListing(proposals: readonly unknown[]) {
  const { provider, runtime } = createReplayProvider(proposals);
  const result = await runTraverseExtraction({ content: listingHtml(), sourceRef: SOURCE_REF, provider });
  return { result, runtime };
}

describe("the extraction schema is expressible to the real Relay provider", () => {
  it("builds the strict structured-output schema for every target field", () => {
    // Traverse's own builder throws for any `object` or `array` target. This
    // is the call that failed every extraction.
    const schema = buildRelayExtractionSchema(CAMP_TARGET_SCHEMA) as {
      properties: { proposals: { items: { properties: { fieldPath: { enum: string[] } } } } };
    };
    expect(schema.properties.proposals.items.properties.fieldPath.enum).toEqual(CAMP_TARGET_SCHEMA.map((field) => field.path));
    expect(CAMP_TARGET_SCHEMA.filter((field) => field.type === "object" || field.type === "array")).toEqual([]);
  });

  it("runs a whole extraction through the real provider and keeps every grounded proposal", async () => {
    const recorded = loadModelOutput();
    const { result, runtime } = await extractListing(recorded.programs);

    expect(result.error).toBeUndefined();
    expect(result.providerCalls).toBe(1);
    expect(runtime.requests).toHaveLength(1);
    // The request carried the strict schema the real builder produced.
    const tool = runtime.requests[0]!.tools![0]!;
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["proposals"]);
    expect(result.proposals).toHaveLength(recorded.programs.length);
    expect(result.raw.modelSource).toBe("configured");
    expect(result.coverage?.every((entry) => entry.status === "complete")).toBe(true);
  });

  it("folds socialLinks rows back into the stored { platform: url } object, each link citing its own excerpt", async () => {
    const recorded = loadModelOutput();
    const { result } = await extractListing([...recorded.programs, ...recorded.invalidValues]);
    const [item] = assembleItems(result.proposals);

    // Platform names arrive capitalised ("Instagram", "X"); they are matched
    // to the declared spelling, nothing looser.
    expect(item!.scalars.socialLinks?.candidateValue).toEqual({
      instagram: "https://www.instagram.com/pineridgecamps/",
      x: "https://x.com/pineridgecamps/",
      youtube: "https://www.youtube.com/user/pineridgecamps",
    });
    expect(item!.scalars.socialLinks?.excerpt).toBe("[Instagram](https://www.instagram.com/pineridgecamps/)");
    expect(assembledItemToDiffInputs(item!).extracted.socialLinks).toEqual(item!.scalars.socialLinks?.candidateValue);
    expect(CAMP_FIELD_HINTS["items[].socialLinks[].url"]).toBeDefined();
  });
});

describe("a multi-program page whose programs arrive un-indexed", () => {
  it("does not take one program's name as the item's name, and keeps only the scalars every program agrees on", async () => {
    const { result } = await extractListing(loadModelOutput().programs);
    // The structured-output schema only admits declared paths, so no item index arrives.
    expect(result.proposals.every((proposal) => proposal.pathIndices === undefined)).toBe(true);

    const items = assembleItems(result.proposals);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.multiProgram).toEqual({
      names: ["Pine Ridge Junior Camp", "High Meadow Ranch for Girls", "Big Creek Ranch for Boys"],
      withheldFields: ["name"],
    });
    expect(item!.scalars.name).toBeUndefined();
    expect(assembledItemToDiffInputs(item!).extracted.name).toBeUndefined();
    // All three programs link the same enrolment form, so that is the page's.
    expect(item!.scalars.applicationUrl?.candidateValue).toBe("https://register.pineridge.example/apply");
    expect(item!.operatorWarnings.at(-1)).toMatch(/^page lists 3 programs .* the camp name is not proposed from any one program/);
  });

  it("withholds a scalar the programs disagree on", async () => {
    const programs = loadModelOutput().programs.map((proposal) => {
      const p = proposal as { fieldPath: string; locator: string; value: unknown };
      return p.fieldPath === "items[].applicationUrl" && p.locator === "items[2]"
        ? { ...p, value: "https://register.pineridge.example/apply?program=boys" }
        : p;
    });
    const { result } = await extractListing(programs);
    const [item] = assembleItems(result.proposals);
    expect(item!.scalars.applicationUrl).toBeUndefined();
    expect(item!.multiProgram?.withheldFields).toEqual(["name", "applicationUrl"]);
  });

  it("still proposes the name on a page with one program", async () => {
    const onlyFirst = loadModelOutput().programs.filter((proposal) => String((proposal as { locator: string }).locator).startsWith("items[0]"));
    const { result } = await extractListing(onlyFirst);
    const [item] = assembleItems(result.proposals);
    expect(item!.multiProgram).toBeUndefined();
    expect(item!.scalars.name?.candidateValue).toBe("Pine Ridge Junior Camp");
  });

  it("writes each repeated band, price and session once", async () => {
    const { result } = await extractListing(loadModelOutput().programs);
    const [item] = assembleItems(result.proposals);
    // The two ranch programs repeat "Ages 9-17", "$7,400" and the second session.
    expect(item!.ageGroups.map((row) => [row.minAge, row.maxAge])).toEqual([[8, 10], [9, 17]]);
    expect(item!.pricing.map((row) => row.amount)).toEqual([3850, 7400]);
    expect(item!.schedules.map((row) => [row.startDate, row.endDate])).toEqual([
      ["2027-06-06", "2027-06-20"], ["2027-06-22", "2027-07-06"], ["2027-06-06", "2027-07-06"], ["2027-07-10", "2027-08-09"],
    ]);
    // Every list row keeps where its excerpt sits in the prepared text.
    expect(item!.schedules.every((row) => /^chars:\d+-\d+$/.test(row.locator))).toBe(true);
  });
});

describe("values that do not fit their field's declared type", () => {
  it("are refused and named, never carried into a proposed value", async () => {
    const recorded = loadModelOutput();
    const { result } = await extractListing([...recorded.programs, ...recorded.invalidValues]);
    const [item] = assembleItems(result.proposals);

    expect(item!.campTypes).toEqual([]);
    expect(item!.scalars.registrationStatus).toBeUndefined();
    expect(item!.scalars.registrationOpenDate).toBeUndefined();
    expect(item!.refusedValues).toEqual({
      registrationStatus: ["SOLD_OUT"],
      registrationOpenDate: ["January 14"],
      schedules: ["December 21", "2026-12-22"],
      campTypes: ["DAY_CAMP", "DAY"],
    });
    // "December 21" has no year: not a session date. "2026-12-22" has one, but
    // the model supplied it: the excerpt says only "December 22". Neither is
    // a session date the page states. The list change waits.
    expect(item!.schedules).toEqual([]);
    expect(item!.operatorWarnings).toContain(
      '2 session entries dropped (e.g. "Too Cold to Hold: December 21", "Too Hot to Handle: December 22"): no full calendar date (YYYY-MM-DD) was extracted — a date the page does not state in full is not emitted',
    );
    expect(assembledItemToDiffInputs(item!).extracted.campTypes).toBeUndefined();
    expect(assembledItemToDiffInputs(item!).extracted.schedules).toBeUndefined();
  });
});

describe("a list is proposed whole or not at all", () => {
  it("withholds an enum list when any member is invalid, instead of proposing the valid remainder", async () => {
    const recorded = loadModelOutput();
    const { result } = await extractListing([...recorded.programs, ...recorded.mixedEnumList]);
    const [item] = assembleItems(result.proposals);
    // SLEEPAWAY alone would REPLACE the stored list when approved.
    expect(item!.campTypes).toEqual([]);
    expect(item!.refusedValues.campTypes).toEqual(["DAY"]);
    expect(item!.operatorWarnings).toContain(
      'campTypes change withheld: "SLEEPAWAY" not proposed because other value(s) for this list were not valid — approving a partial list would replace the stored one',
    );
    expect(assembledItemToDiffInputs(item!).extracted.campTypes).toBeUndefined();
  });

  it("names the entries it left out because another entry had the same values", async () => {
    const recorded = loadModelOutput();
    const { result } = await extractListing([...recorded.programs, ...recorded.invalidValues, ...recorded.duplicates]);
    const [item] = assembleItems(result.proposals);
    expect((item!.scalars.socialLinks?.candidateValue as Record<string, string>).instagram).toBe("https://www.instagram.com/pineridgecamps/");
    expect(item!.droppedEntries).toContain(
      "socialLinks: a second instagram link (https://www.instagram.com/pineridgeranch/) was left out; https://www.instagram.com/pineridgecamps/ was kept",
    );

    const clean = assembleItems((await extractListing(recorded.programs)).result.proposals)[0]!;
    // Two programs run a session on the same dates under different wording.
    // An identical repeat ("**Second Session:** July 10th - Aug. 9th, 2027" twice) is not listed.
    expect(clean.droppedEntries).toEqual([
      'schedules: "**First Session:** June 6th - July 6th, 2027" was left out because it has the same values as "**First Session:** June 6 - July 6th, 2027"',
    ]);
  });
});
