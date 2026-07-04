/**
 * tests/integration/editable-fields.test.ts — structural guardrail for V5
 * (security review SF1) and V13 (verifier-iter2, same vulnerability class
 * found in a sibling route): both
 * `app/api/admin/camps/[campId]/route.ts`'s PATCH and
 * `app/api/admin/assistant/route.ts`'s `write_camp_update` action build
 * their `SET` clause dynamically from an allowlist Set, so a plain text
 * grep for `dataConfidence =` (AC1's original guardrail check) cannot see
 * whether either dynamic clause still allows an evidence-free
 * `dataConfidence`/`lastVerifiedAt` write. This file imports both routes'
 * own allowlist Sets directly and asserts, structurally, that neither ever
 * contains either derived column — `lib/admin/verification-authority.ts`'s
 * `refreshCampVerificationCache` must remain their one and only writer.
 *
 * No database connection needed — importing either route module only
 * evaluates its top-level allowlist/`FORBIDDEN_*` construction (`getPool()`
 * is called lazily, inside the exported handlers, never at import time), so
 * this is safe to run without `TEST_DATABASE_URL`. Lives under
 * `tests/integration/` (not a separate `tests/unit/` directory) only
 * because `vitest.config.ts`'s `include` glob is scoped to
 * `tests/integration/**\/*.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { EDITABLE_FIELDS } from "@/app/api/admin/camps/[campId]/route";
import { CAMP_UPDATE_FIELDS } from "@/app/api/admin/assistant/route";

describe("EDITABLE_FIELDS structural guardrail (V5, security review SF1)", () => {
  it("never includes dataConfidence or lastVerifiedAt — both are derived, cache-only columns whose sole writer is refreshCampVerificationCache", () => {
    expect(EDITABLE_FIELDS.has("dataConfidence")).toBe(false);
    expect(EDITABLE_FIELDS.has("lastVerifiedAt")).toBe(false);
  });

  it("still allows genuinely admin-editable Camp fields through (sanity check that this isn't an empty/broken set)", () => {
    expect(EDITABLE_FIELDS.has("name")).toBe(true);
    expect(EDITABLE_FIELDS.has("description")).toBe(true);
    expect(EDITABLE_FIELDS.size).toBeGreaterThan(0);
  });
});

describe("CAMP_UPDATE_FIELDS structural guardrail (V13, mirrors V5 in the sibling assistant route)", () => {
  it("never includes dataConfidence or lastVerifiedAt — both are derived, cache-only columns whose sole writer is refreshCampVerificationCache", () => {
    expect(CAMP_UPDATE_FIELDS.has("dataConfidence")).toBe(false);
    expect(CAMP_UPDATE_FIELDS.has("lastVerifiedAt")).toBe(false);
  });

  it("still allows genuinely admin-editable Camp fields through (sanity check that this isn't an empty/broken set)", () => {
    expect(CAMP_UPDATE_FIELDS.has("name")).toBe(true);
    expect(CAMP_UPDATE_FIELDS.has("description")).toBe(true);
    expect(CAMP_UPDATE_FIELDS.size).toBeGreaterThan(0);
  });
});
