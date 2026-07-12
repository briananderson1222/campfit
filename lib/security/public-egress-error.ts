import { EgressUrlPolicyError } from "./egress-url-policy";

export class UpstreamProviderError extends Error {
  readonly name = "UpstreamProviderError";
  constructor(readonly cause?: unknown) { super("Upstream provider request failed"); }
}

export function publicEgressError(error: unknown): string {
  if (error instanceof EgressUrlPolicyError) return "Outbound request was rejected by security policy";
  if (error instanceof UpstreamProviderError) return "Upstream provider request failed";
  return "Crawl request failed";
}

export function logAndMapPublicEgressError(context: string, error: unknown): string {
  console.error(context, error);
  return publicEgressError(error);
}
