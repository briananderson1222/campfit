import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The Datum role points the anthropic runtime at a loopback endpoint that is
// always overloaded, so the test counts the provider requests one extraction
// chunk actually makes. No network, no credential.
let baseUrl = "";
vi.mock("@kontourai/datum", () => ({
  resolve: vi.fn(() => ({
    provider: "fixture",
    kind: "anthropic-compatible",
    baseUrl,
    apiKey: ["test", "only", "credential"].join("-"),
    model: "fixture-model",
  })),
}));

import { extract } from "@kontourai/traverse";
import {
  DEFAULT_EXTRACTION_MAX_RETRIES,
  resolveExtractionProvider,
} from "@/lib/ingestion/resolve-extraction-provider";

describe("extraction provider retries (relay 0.7 defaults Anthropic maxRetries to 0)", () => {
  let server: Server;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(529, {
        "content-type": "application/json",
        // Keeps the SDK's backoff to a millisecond.
        "retry-after-ms": "1",
      });
      response.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("retries an overloaded response before giving up the chunk", async () => {
    expect(DEFAULT_EXTRACTION_MAX_RETRIES).toBe(2);
    delete process.env.TRAVERSE_RUNTIME_PROFILES;
    const { provider } = resolveExtractionProvider();
    requests = 0;

    const result = await extract({
      content: "Camp Fixture runs June 1 to June 5.",
      contentType: "text",
      targetSchema: [{ path: "items[].name", type: "string", description: "camp name" }],
      provider,
    });

    // One initial request plus the explicit retries; relay 0.7's default
    // (no retries) would make exactly one.
    expect(requests).toBe(1 + DEFAULT_EXTRACTION_MAX_RETRIES);
    // The run that lost its only chunk must not read as a clean empty result.
    expect(result.proposals).toEqual([]);
    expect(result.error ?? result.partial).toBeDefined();
  });
});
