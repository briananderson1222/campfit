import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { FetchSourceOptions } from "@kontourai/traverse/fetch";

export const EGRESS_POLICY_PROFILES = [
  "operatorDiscovery", "storedCrawlTarget", "discoveredLink", "browserSubresource", "fixedHarvester",
] as const;
export type EgressPolicyProfile = (typeof EGRESS_POLICY_PROFILES)[number];
export type EgressAddress = { address: string; family: 4 | 6 };
export type EgressResolver = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
export type EgressConnector = (request: { request: Request; url: URL; address: EgressAddress }) => Promise<Response>;

export type EgressPolicyErrorCode =
  | "INVALID_URL" | "INVALID_SCHEME" | "CREDENTIALS" | "INVALID_HOST" | "DENIED_HOST"
  | "INVALID_PORT" | "DNS_FAILURE" | "DENIED_ADDRESS" | "REDIRECT_INVALID"
  | "REDIRECT_LIMIT" | "REDIRECT_LOOP" | "CONNECT_FAILED";

export class EgressUrlPolicyError extends Error {
  readonly name = "EgressUrlPolicyError";
  constructor(
    readonly code: EgressPolicyErrorCode,
    readonly profile: EgressPolicyProfile,
    readonly safeHost?: string,
  ) {
    super(`Server egress rejected (${code})${safeHost ? ` for ${safeHost}` : ""}`);
  }
}

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data", "metadata.azure.internal"]);

function fail(code: EgressPolicyErrorCode, profile: EgressPolicyProfile, host?: string): never {
  throw new EgressUrlPolicyError(code, profile, host);
}

function ipv4Bytes(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function ipv6Bytes(address: string): number[] | null {
  const unbracketed = address.replace(/^\[|\]$/g, "");
  if (unbracketed.includes("%") || isIP(unbracketed) !== 6) return null;
  let value = unbracketed;
  const dottedAt = value.lastIndexOf(":");
  if (value.includes(".")) {
    const v4 = ipv4Bytes(value.slice(dottedAt + 1));
    if (!v4) return null;
    value = `${value.slice(0, dottedAt)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(zeros).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const number = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || number > 0xffff) return null;
    bytes.push(number >> 8, number & 255);
  }
  return bytes;
}

function prefix(bytes: number[], network: number[], bits: number): boolean {
  const whole = Math.floor(bits / 8);
  const remainder = bits % 8;
  for (let index = 0; index < whole; index++) if (bytes[index] !== network[index]) return false;
  return remainder === 0 || (bytes[whole] & (0xff << (8 - remainder))) === (network[whole] & (0xff << (8 - remainder)));
}

const V4_DENY: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

const V6_DENY: Array<[number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 64],
  [[0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 23],
  [[0x20, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 48],
  [[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32],
  [[0x20, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 7],
  [[0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xfe, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8],
];

function classifyAddress(address: string, profile: EgressPolicyProfile, safeHost: string): EgressAddress {
  const v4 = ipv4Bytes(address);
  if (v4) {
    if (V4_DENY.some(([network, bits]) => prefix(v4, network, bits))) fail("DENIED_ADDRESS", profile, safeHost);
    return { address: v4.join("."), family: 4 };
  }
  const v6 = ipv6Bytes(address);
  if (!v6) fail("INVALID_HOST", profile, safeHost);
  const mapped = prefix(v6, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0], 96);
  if (mapped) return classifyAddress(v6.slice(12).join("."), profile, safeHost);
  if (V6_DENY.some(([network, bits]) => prefix(v6, network, bits))) fail("DENIED_ADDRESS", profile, safeHost);
  return { address, family: 6 };
}

const defaultResolver: EgressResolver = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export async function evaluateEgressUrl(
  raw: string | URL,
  profile: EgressPolicyProfile,
  deps: { resolver?: EgressResolver } = {},
): Promise<{ url: URL; addresses: EgressAddress[] }> {
  const source = String(raw);
  let url: URL;
  try { url = new URL(source); } catch { fail("INVALID_URL", profile); }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("INVALID_SCHEME", profile, url.hostname);
  if (url.username || url.password) fail("CREDENTIALS", profile, url.hostname);
  const rawAuthority = source.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]?.replace(/^[^@]*@/, "") ?? "";
  const rawHost = rawAuthority.startsWith("[") ? rawAuthority.slice(0, rawAuthority.indexOf("]") + 1) : rawAuthority.split(":")[0];
  if (/^(?:0x|0\d|\d+\.\d*$|\d+$)/i.test(rawHost) && isIP(rawHost) !== 4) fail("INVALID_HOST", profile, url.hostname);
  let hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.includes("%") || METADATA_HOSTS.has(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")) fail("DENIED_HOST", profile, hostname);
  const explicitPort = url.port;
  if ((url.protocol === "http:" && explicitPort && explicitPort !== "80") || (url.protocol === "https:" && explicitPort && explicitPort !== "443")) fail("INVALID_PORT", profile, hostname);
  url.hostname = hostname;
  url.hash = "";
  let answers: Array<{ address: string; family?: number }>;
  if (isIP(hostname)) answers = [{ address: hostname }];
  else {
    try { answers = await (deps.resolver ?? defaultResolver)(hostname); } catch { fail("DNS_FAILURE", profile, hostname); }
  }
  if (!answers.length) fail("DNS_FAILURE", profile, hostname);
  const addresses = answers.map(({ address }) => classifyAddress(address, profile, hostname));
  return { url, addresses };
}

const defaultConnector: EgressConnector = async ({ request, url, address }) => {
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const headers = Object.fromEntries(request.headers);
    headers.host = url.host;
    const outgoing = transport.request({
      protocol: url.protocol, hostname: address.address, family: address.family, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`, method: request.method, headers,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500, headers: incoming.headers as HeadersInit })));
    });
    outgoing.once("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
};

export function createGuardedFetch(options: {
  profile?: EgressPolicyProfile; resolver?: EgressResolver; connector?: EgressConnector;
  fetchImpl?: typeof fetch; maxRedirects?: number;
} = {}): typeof fetch {
  const profile = options.profile ?? "operatorDiscovery";
  // An injected fetch is a deterministic test/adapter seam. It remains beneath
  // policy evaluation and manual redirect handling, so caller composition can
  // never replace the guard. Production (no injection) uses the pinned socket
  // connector above.
  const connector = options.connector ?? (options.fetchImpl
    ? async ({ request }: Parameters<EgressConnector>[0]) => options.fetchImpl!(request, { redirect: "manual" })
    : defaultConnector);
  const maxRedirects = options.maxRedirects ?? 5;
  return async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    const seen = new Set<string>();
    for (let hop = 0; ; hop++) {
      const evaluated = await evaluateEgressUrl(request.url, profile, { resolver: options.resolver });
      if (seen.has(evaluated.url.href)) fail("REDIRECT_LOOP", profile, evaluated.url.hostname);
      seen.add(evaluated.url.href);
      let response: Response;
      try { response = await connector({ request, url: evaluated.url, address: evaluated.addresses[0] }); }
      catch { fail("CONNECT_FAILED", profile, evaluated.url.hostname); }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (hop >= maxRedirects) fail("REDIRECT_LIMIT", profile, evaluated.url.hostname);
      const location = response.headers.get("location");
      if (!location) return response;
      let next: URL;
      try { next = new URL(location, evaluated.url); } catch { fail("REDIRECT_INVALID", profile, evaluated.url.hostname); }
      const headers = new Headers(request.headers);
      if (next.origin !== evaluated.url.origin) {
        headers.delete("authorization"); headers.delete("cookie"); headers.delete("proxy-authorization");
      }
      const rewrite = response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === "POST");
      request = new Request(next, { method: rewrite ? "GET" : request.method, headers, body: rewrite || request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer(), redirect: "manual" });
    }
  };
}

/**
 * Compose CampFit's policy over Traverse's fetch seam. Spread ordering is
 * deliberate: every non-network option survives, while `fetch` is always the
 * final guarded value and therefore cannot be bypassed by caller injection.
 */
export function createGuardedTraverseFetchOptions(
  existing: FetchSourceOptions | undefined,
  profile: EgressPolicyProfile,
  deps: { resolver?: EgressResolver; connector?: EgressConnector } = {},
): FetchSourceOptions {
  const injected = existing?.fetch;
  // A caller-supplied FetchLike is a trusted, non-socket transport seam (the
  // repository uses it for deterministic fixtures). It is still subordinate
  // to literal/hostname/redirect policy. With no explicit resolver there is no
  // OS connection to pin or DNS answer to classify, so use a public sentinel;
  // threat fixtures inject a resolver to exercise private/mixed DNS answers.
  const resolver = deps.resolver ?? (injected ? async () => [{ address: "93.184.216.34", family: 4 }] : undefined);
  const fetchImpl: typeof fetch | undefined = injected
    ? async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const headers = Object.fromEntries(request.headers);
      // Preserve Traverse's documented header spellings for structural test
      // fakes and consumers that inspect the record directly.
      if (headers["if-none-match"] !== undefined) {
        headers["If-None-Match"] = headers["if-none-match"];
        delete headers["if-none-match"];
      }
      if (headers["if-modified-since"] !== undefined) {
        headers["If-Modified-Since"] = headers["if-modified-since"];
        delete headers["if-modified-since"];
      }
      return injected(request.url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: request.signal,
      }) as Promise<Response>;
    }
    : undefined;
  const guarded = createGuardedFetch({ profile, resolver, connector: deps.connector, fetchImpl });
  return {
    ...existing,
    fetch: (url, init) => guarded(url, init) as ReturnType<NonNullable<FetchSourceOptions["fetch"]>>,
  };
}
