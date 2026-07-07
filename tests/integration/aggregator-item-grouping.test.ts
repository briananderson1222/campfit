/**
 * tests/integration/aggregator-item-grouping.test.ts — unit coverage for
 * `groupAggregatorCandidates` (campfit#93, Wave 2 Task 2.2, R2).
 *
 * No database involved (a hand-built `ExtractionProposal[]`, not a real
 * `extract()` call) — this lives under tests/integration/ only because the
 * repo has no tests/unit directory and vitest.config.ts's `include` is
 * scoped to `tests/integration/**\/*.test.ts` (verified: no tests/unit dir
 * exists at execution time).
 */
import { describe, expect, it } from "vitest";
import type { ExtractionProposal } from "@kontourai/traverse";

import { groupAggregatorCandidates } from "@/lib/ingestion/aggregator/aggregator-item-grouping";

function proposal(
  fieldPath: string,
  candidateValue: unknown,
  excerpt: string,
  pathIndices?: number[],
): ExtractionProposal {
  return {
    fieldPath,
    candidateValue,
    confidence: 0.9,
    provenance: { excerpt, locator: `chars:0-${excerpt.length}` },
    extractor: "test-extractor",
    ...(pathIndices ? { pathIndices } : {}),
  };
}

describe("groupAggregatorCandidates", () => {
  it("reconstructs 3 items across pathIndices[0], preserving per-field provenance, a missing field, and out-of-order fields", () => {
    const proposals: ExtractionProposal[] = [
      // item 0 — in-order, fully populated.
      proposal("items[].name", "Camp Alpha", "Camp Alpha", [0]),
      proposal("items[].websiteUrl", "https://alpha.example", "https://alpha.example", [0]),
      proposal("items[].locale", "Denver, CO", "Denver, CO", [0]),

      // item 1 — deliberately missing websiteUrl.
      proposal("items[].name", "Camp Beta", "Camp Beta", [1]),
      proposal("items[].locale", "Boulder", "Boulder", [1]),

      // item 2 — fields deliberately out of order (locale, then websiteUrl, then name).
      proposal("items[].locale", "Golden", "Golden", [2]),
      proposal("items[].websiteUrl", "https://gamma.example", "https://gamma.example", [2]),
      proposal("items[].name", "Camp Gamma", "Camp Gamma", [2]),
    ];

    const items = groupAggregatorCandidates(proposals);
    expect(items).toHaveLength(3);

    expect(items[0].itemIndex).toBe(0);
    expect(items[0].name).toEqual({ value: "Camp Alpha", provenance: { excerpt: "Camp Alpha", locator: "chars:0-10" } });
    expect(items[0].websiteUrl?.value).toBe("https://alpha.example");
    expect(items[0].locale?.value).toBe("Denver, CO");

    expect(items[1].itemIndex).toBe(1);
    expect(items[1].name?.value).toBe("Camp Beta");
    expect(items[1].websiteUrl).toBeUndefined(); // missing field -> undefined, item still present.
    expect(items[1].locale?.value).toBe("Boulder");

    expect(items[2].itemIndex).toBe(2);
    expect(items[2].name?.value).toBe("Camp Gamma");
    expect(items[2].websiteUrl?.value).toBe("https://gamma.example");
    expect(items[2].locale?.value).toBe("Golden");
  });

  it("treats a proposal with no pathIndices as item 0 (un-indexed single-item page)", () => {
    const proposals: ExtractionProposal[] = [
      proposal("items[].name", "Solo Camp", "Solo Camp"),
      proposal("items[].websiteUrl", "https://solo.example", "https://solo.example"),
    ];

    const items = groupAggregatorCandidates(proposals);
    expect(items).toHaveLength(1);
    expect(items[0].itemIndex).toBe(0);
    expect(items[0].name?.value).toBe("Solo Camp");
    expect(items[0].websiteUrl?.value).toBe("https://solo.example");
  });

  it("ignores proposals outside the items[] schema prefix and unknown field names", () => {
    const proposals: ExtractionProposal[] = [
      proposal("unrelatedField", "x", "x"),
      proposal("items[].notAField", "y", "y", [0]),
    ];
    expect(groupAggregatorCandidates(proposals)).toHaveLength(0);
  });

  it("keeps the last proposal when a field is proposed more than once for the same item", () => {
    const proposals: ExtractionProposal[] = [
      proposal("items[].name", "First Pass", "First Pass", [0]),
      proposal("items[].name", "Second Pass", "Second Pass", [0]),
    ];
    const items = groupAggregatorCandidates(proposals);
    expect(items).toHaveLength(1);
    expect(items[0].name?.value).toBe("Second Pass");
  });
});
