/**
 * Provider resolution against the REAL datum config (`.datum/config.json`),
 * with no API key in the environment. The sibling test file mocks datum, so
 * it cannot see that `resolve()` demands `ZAI_API_KEY`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveExtractionProvider } from "@/lib/ingestion/resolve-extraction-provider";
import { runTraverseExtraction } from "@/lib/ingestion/traverse-extractor";
import { createReplayProvider, listingHtml, loadModelOutput } from "../fixtures/real-crawl/replay";

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

  it("names every configured profile and model when requests go through Dispatch", () => {
    // A Dispatch runtime's id names no model. The provider name is what a
    // proposal records and what the content fingerprint hashes.
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-6.1-sol,claude-code:sonnet";
    const two = resolveExtractionProvider().provider.name;
    expect(two).toBe("relay-extraction-provider:campfit-extraction-dispatch/codex:gpt-6.1-sol+claude-code:sonnet");

    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-6.1-sol";
    process.env.TRAVERSE_DISPATCH_RECEIPT_PATH = "/dev/null";
    const withReceipts = resolveExtractionProvider().provider.name;
    expect(withReceipts).toBe("relay-extraction-provider:campfit-extraction-dispatch/codex:gpt-6.1-sol");
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-7-next";
    expect(resolveExtractionProvider().provider.name).not.toBe(withReceipts);
  });

  it("gives a Dispatch provider a name Traverse accepts, so an extraction runs", async () => {
    // Traverse refuses a provider name it cannot carry before calling the
    // model. Only the name is taken from the resolver; the answer is replayed.
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-6.1-sol,claude-code:sonnet";
    const name = resolveExtractionProvider().provider.name;
    const { provider } = createReplayProvider(loadModelOutput().programs);
    const result = await runTraverseExtraction({ content: listingHtml(), sourceRef: "https://pineridge.example/dates-rates", provider: { ...provider, name } });
    expect(result.error).toBeUndefined();
    expect(result.proposals.length).toBeGreaterThan(0);
  });

  it("still requires the key for the default hosted runtime", () => {
    expect(() => resolveExtractionProvider()).toThrow(/ZAI_API_KEY/);
  });

  it("still requires the key when an anthropic profile is one of several", () => {
    process.env.TRAVERSE_RUNTIME_PROFILES = "codex:gpt-6.1-sol,anthropic:glm-5.2";
    expect(() => resolveExtractionProvider()).toThrow(/ZAI_API_KEY/);
  });
});
