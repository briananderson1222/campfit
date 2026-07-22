import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kontourai/datum", () => ({
  resolve: vi.fn(() => ({
    provider: "zai",
    kind: "anthropic-compatible",
    baseUrl: "https://example.invalid/anthropic",
    apiKey: ["test", "only", "credential"].join("-"),
    model: "glm-5.2",
  })),
}));

import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";

const runtimeEnvironment = [
  "TRAVERSE_RUNTIME_PROFILES",
  "TRAVERSE_ALLOW_PROMPTED_STRUCTURED_OUTPUT",
  "TRAVERSE_DISPATCH_MAX_ATTEMPTS",
  "TRAVERSE_DISPATCH_RECEIPT_PATH",
] as const;

describe("application-owned extraction runtime composition", () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of runtimeEnvironment) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of runtimeEnvironment) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps the Datum-backed hosted runtime as the default", () => {
    const resolved = resolveExtractionProvider();
    expect(resolved.provider.name).toBe("relay-extraction-provider:anthropic-compatible:glm-5.2");
    expect(resolved.model).toBe("glm-5.2");
  });

  it("selects an authenticated local harness without changing Traverse semantics", () => {
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-5";
    const resolved = resolveExtractionProvider();
    expect(resolved.provider.name).toBe("relay-extraction-provider:codex:gpt-5");
  });

  it("requires explicit consent for prompt-enforced structured output", () => {
    process.env.TRAVERSE_RUNTIME_PROFILES = "opencode:zai/glm-5";
    expect(() => resolveExtractionProvider()).toThrow(/explicit prompted-output opt-in/);
  });

  it("rejects an invalid Dispatch attempt ceiling before invocation", () => {
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-5,claude-code:sonnet";
    process.env.TRAVERSE_DISPATCH_MAX_ATTEMPTS = "0";
    expect(() => resolveExtractionProvider()).toThrow(/must be a positive integer/);
  });
});
