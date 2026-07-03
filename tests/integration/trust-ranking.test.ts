/**
 * tests/integration/trust-ranking.test.ts — AC2 (verified-first default
 * ranking) and AC5 (revertible display/ranking flags) for lib/trust.ts.
 *
 * Pure-function suite: no database. It lives under tests/integration/ so the
 * repo's single `vitest run` command (which applies globalSetup) covers it,
 * but it never touches the test pool.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  applyDefaultRanking,
  isFlagEnabled,
  isTrustDisplayEnabled,
  isVerifiedRankingEnabled,
  rankByTrust,
  trustStatus,
} from "@/lib/trust";
import type { Camp } from "@/lib/types";

type RankCamp = Pick<Camp, "id" | "name" | "dataConfidence">;

function camp(id: string, dataConfidence: Camp["dataConfidence"]): RankCamp {
  return { id, name: id, dataConfidence };
}

const ORIGINAL_DISPLAY = process.env.NEXT_PUBLIC_TRUST_DISPLAY;
const ORIGINAL_RANKING = process.env.NEXT_PUBLIC_VERIFIED_RANKING;

afterEach(() => {
  // Restore process env so flag toggles never leak across tests.
  if (ORIGINAL_DISPLAY === undefined) delete process.env.NEXT_PUBLIC_TRUST_DISPLAY;
  else process.env.NEXT_PUBLIC_TRUST_DISPLAY = ORIGINAL_DISPLAY;
  if (ORIGINAL_RANKING === undefined) delete process.env.NEXT_PUBLIC_VERIFIED_RANKING;
  else process.env.NEXT_PUBLIC_VERIFIED_RANKING = ORIGINAL_RANKING;
});

describe("isFlagEnabled", () => {
  it("defaults ON when unset", () => {
    expect(isFlagEnabled(undefined)).toBe(true);
  });
  it("is OFF only for explicit disable values", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off "]) {
      expect(isFlagEnabled(v)).toBe(false);
    }
  });
  it("is ON for enable-ish values", () => {
    for (const v of ["1", "true", "on", "yes", ""]) {
      expect(isFlagEnabled(v)).toBe(true);
    }
  });
});

describe("rankByTrust (AC2)", () => {
  it("orders every verified camp ahead of every unverified camp", () => {
    const input = [
      camp("a", "PLACEHOLDER"),
      camp("b", "VERIFIED"),
      camp("c", "STALE"),
      camp("d", "VERIFIED"),
    ];
    const ranked = rankByTrust(input).map((c) => c.id);
    // First two are the verified ones, remaining are unverified.
    expect(ranked.slice(0, 2).sort()).toEqual(["b", "d"]);
    expect(ranked.slice(2).sort()).toEqual(["a", "c"]);
  });

  it("is stable — preserves input order within each trust group", () => {
    const input = [
      camp("v1", "VERIFIED"),
      camp("u1", "PLACEHOLDER"),
      camp("v2", "VERIFIED"),
      camp("u2", "STALE"),
      camp("u3", "PLACEHOLDER"),
    ];
    expect(rankByTrust(input).map((c) => c.id)).toEqual([
      "v1",
      "v2",
      "u1",
      "u2",
      "u3",
    ]);
  });

  it("never drops camps (a near-0%-coverage catalog is reordered, not emptied)", () => {
    const input = Array.from({ length: 50 }, (_, i) => camp(`u${i}`, "PLACEHOLDER"));
    expect(rankByTrust(input)).toHaveLength(50);
  });
});

describe("applyDefaultRanking + flags (AC2/AC5)", () => {
  const input = [
    camp("u", "PLACEHOLDER"),
    camp("v", "VERIFIED"),
  ];

  it("ranks verified-first when the ranking flag is ON (default)", () => {
    delete process.env.NEXT_PUBLIC_VERIFIED_RANKING;
    expect(isVerifiedRankingEnabled()).toBe(true);
    expect(applyDefaultRanking(input).map((c) => c.id)).toEqual(["v", "u"]);
  });

  it("restores prior (input) order when the flag is reverted to 0 (AC5)", () => {
    process.env.NEXT_PUBLIC_VERIFIED_RANKING = "0";
    expect(isVerifiedRankingEnabled()).toBe(false);
    expect(applyDefaultRanking(input).map((c) => c.id)).toEqual(["u", "v"]);
  });
});

describe("trust display flag (AC5)", () => {
  it("is ON by default and OFF when reverted", () => {
    delete process.env.NEXT_PUBLIC_TRUST_DISPLAY;
    expect(isTrustDisplayEnabled()).toBe(true);
    process.env.NEXT_PUBLIC_TRUST_DISPLAY = "false";
    expect(isTrustDisplayEnabled()).toBe(false);
  });
});

describe("trustStatus (R1 honesty)", () => {
  it("labels unverified plainly and points to the camp website", () => {
    const s = trustStatus({ dataConfidence: "PLACEHOLDER", lastVerifiedAt: null });
    expect(s.verified).toBe(false);
    expect(s.label).toBe("Unverified");
    expect(s.detail.toLowerCase()).toContain("camp website");
  });

  it("stamps verified camps with the confirmation month when known", () => {
    const s = trustStatus({
      dataConfidence: "VERIFIED",
      lastVerifiedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(s.verified).toBe(true);
    expect(s.label).toMatch(/^Verified /);
  });

  it("never claims a date it does not have", () => {
    const s = trustStatus({ dataConfidence: "VERIFIED", lastVerifiedAt: null });
    expect(s.label).toBe("Verified");
  });
});
