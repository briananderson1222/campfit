/**
 * Provider resolution against the REAL datum config (`.datum/config.json`),
 * with no API key in the environment. The sibling test file mocks datum, so
 * it cannot see that `resolve()` demands `ZAI_API_KEY`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";

const KEYS = ["ZAI_API_KEY", "ANTHROPIC_API_KEY", "TRAVERSE_RUNTIME_PROFILES", "TRAVERSE_ROLE", "TRAVERSE_MODEL", "TRAVERSE_DISPATCH_RECEIPT_PATH", "TRAVERSE_DISPATCH_MAX_ATTEMPTS"] as const;

describe("extraction provider resolution without an API key", () => {
  const previous = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of KEYS) { previous.set(key, process.env[key]); delete process.env[key]; }
  });
  afterEach(() => {
    for (const key of KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("resolves a CLI runtime profile with no API key set", () => {
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-6.1-sol";
    const resolved = resolveExtractionProvider();
    expect(resolved.provider.name).toBe("relay-extraction-provider:codex:gpt-6.1-sol");
    expect(resolved.model).toBe("gpt-6.1-sol");
    expect(resolved.datumProvider).toBe("codex");
    expect(resolved.baseUrl).toBeUndefined();
  });

  it("still requires the key for the default hosted runtime", () => {
    expect(() => resolveExtractionProvider()).toThrow(/ZAI_API_KEY/);
  });

  it("still requires the key when an anthropic profile is one of several", () => {
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-6.1-sol,anthropic:glm-5.2";
    expect(() => resolveExtractionProvider()).toThrow(/ZAI_API_KEY/);
  });
});
