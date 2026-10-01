/**
 * Replays a recorded structured-tool answer through the REAL Relay extraction
 * provider (`createRelayExtractionProvider`). Only the model runtime is a
 * stand-in, so every `extract()` call still builds the strict output schema
 * with Traverse's own `buildRelayExtractionSchema` — the guard that rejects an
 * `object`/`array` target runs exactly as it does in a live crawl.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInvocationRequest, ModelRuntime } from "@kontourai/relay";
import type { ExtractionProvider } from "@kontourai/traverse";
import { createRelayExtractionProvider } from "@kontourai/traverse/relay";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface RecordedModelOutput {
  programs: unknown[];
  invalidValues: unknown[];
}

export function loadModelOutput(): RecordedModelOutput {
  return JSON.parse(readFileSync(path.join(here, "model-output.json"), "utf8")) as RecordedModelOutput;
}

/** One fetch of the listing page. The tokens stand for what a live page changes on every request. */
export function listingHtml(tokens: { request?: string; cfEmail?: string } = {}): string {
  return readFileSync(path.join(here, "program-listing.html"), "utf8")
    .replaceAll("__REQUEST_TOKEN__", tokens.request ?? "1790821483")
    .replaceAll("__CF_EMAIL_TOKEN__", tokens.cfEmail ?? "6201030f1222060f0c114c0d1005");
}

export interface ReplayRuntime extends ModelRuntime {
  /** Every request the provider sent, in order. */
  readonly requests: ModelInvocationRequest[];
}

/** A model runtime that answers every request with the recorded tool input, the way the codex CLI runtime reported it. */
export function createReplayRuntime(proposals: readonly unknown[]): ReplayRuntime {
  const requests: ModelInvocationRequest[] = [];
  return {
    id: "codex:gpt-6.1-sol",
    requests,
    capabilities: () => ({ structuredTools: true, structuredToolsFidelity: "native", streaming: false, abort: true, usage: true }),
    async invoke(request) {
      requests.push(request);
      return {
        provider: "codex",
        model: "gpt-6.1-sol",
        modelSource: "configured",
        outputText: "",
        toolCalls: [{ id: `call-${requests.length}`, name: request.tools![0]!.name, input: { proposals } }],
        usage: { inputTokens: 22448, outputTokens: 409, totalTokens: 22857 },
        latencyMs: 1,
        stopReason: "end_turn",
      };
    },
  };
}

export function createReplayProvider(proposals: readonly unknown[]): { provider: ExtractionProvider; runtime: ReplayRuntime } {
  const runtime = createReplayRuntime(proposals);
  return { provider: createRelayExtractionProvider({ runtime, maxTokens: 2048 }), runtime };
}
