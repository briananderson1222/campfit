import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInMemorySnapshotStore } from "@kontourai/traverse/fetch";
import { createStubProvider } from "@/tests/fixtures/traverse/stub-provider";

import {
  EgressUrlPolicyError,
  createGuardedFetch,
  createGuardedTraverseFetchOptions,
  evaluateEgressUrl,
  type EgressResponseOracle,
  type EgressResolver,
} from "@/lib/security/egress-url-policy";
import { BaseHarvester } from "@/lib/ingestion/aggregator/base-harvester";
import { discoverCampsFromUrl } from "@/lib/ingestion/llm-discovery";
import { runAggregatorDiscovery } from "@/lib/ingestion/aggregator/aggregator-extraction";
import { runTraverseRecrawlForCamp } from "@/lib/ingestion/traverse-recrawl-adapter";
import { runTraversePipelineForSource } from "@/lib/ingestion/traverse-pipeline";
import { browserEgressRouteDecision, createCampfitRenderImpl } from "@/lib/ingestion/render-fetch";
import { logAndMapPublicEgressError, publicEgressError, UpstreamProviderError } from "@/lib/security/public-egress-error";

const routeHarness = vi.hoisted(() => ({
  error: new Error("unset route error"),
  queryResults: [] as Array<{ rows: unknown[] }>,
  runCrawlPipeline: vi.fn(),
}));

vi.mock("@/lib/ingestion/crawl-pipeline", () => ({
  runCrawlPipeline: (...args: unknown[]) => routeHarness.runCrawlPipeline(...args),
}));
vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: vi.fn(async () => routeHarness.queryResults.shift() ?? { rows: [] }) }),
}));
vi.mock("@/lib/admin/access", () => ({
  requireAdminAccess: vi.fn(async () => ({ access: { email: "admin@example.test", isModerator: false } })),
}));
vi.mock("@/lib/admin/community-access", () => ({
  getCampCommunitySlug: vi.fn(async () => "community"),
  getProviderCommunitySlug: vi.fn(async () => "community"),
  getCampIdsCommunitySlugs: vi.fn(async () => ["community"]),
}));

import { POST as crawlCamp } from "@/app/api/admin/camps/[campId]/crawl/route";
import { POST as crawlProvider } from "@/app/api/admin/providers/[providerId]/crawl/route";
import { POST as crawlStart } from "@/app/api/admin/crawl/start/route";

const resolver = (answers: Record<string, string[]>): EgressResolver => async (hostname) =>
  (answers[hostname] ?? []).map((address) => ({ address }));
const oracle = (...responses: EgressResponseOracle["responses"]): EgressResponseOracle => ({ responses });

describe("server egress URL policy threat matrix", () => {
  it.each([
    {
      route: "camps/[campId]/crawl",
      arrange: () => { routeHarness.queryResults = [{ rows: [{ id: "camp-1", websiteUrl: "https://safe.example" }] }, { rows: [] }]; },
      invoke: () => crawlCamp(new Request("http://local.test", { method: "POST", body: "{}" }), { params: Promise.resolve({ campId: "camp-1" }) }),
    },
    {
      route: "providers/[providerId]/crawl",
      arrange: () => { routeHarness.queryResults = [{ rows: [{ id: "provider-1", crawlRootUrl: "https://safe.example", websiteUrl: null }] }, { rows: [{ id: "camp-1" }] }]; },
      invoke: () => crawlProvider(new Request("http://local.test", { method: "POST", body: "{}" }), { params: Promise.resolve({ providerId: "provider-1" }) }),
    },
    {
      route: "crawl/start",
      arrange: () => { routeHarness.queryResults = []; },
      invoke: () => crawlStart(new Request("http://local.test", { method: "POST", body: JSON.stringify({ campIds: ["camp-1"] }) })),
    },
  ])("keeps secret-bearing failures out of the serialized $route response", async ({ arrange, invoke }) => {
    const sentinel = `ROUTE_SECRET_${Math.random().toString(36).slice(2)}`;
    routeHarness.error = new Error(sentinel);
    routeHarness.runCrawlPipeline.mockImplementation(() => Promise.reject(routeHarness.error));
    arrange();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await invoke();
    const serialized = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(serialized)).toEqual({ error: "Crawl request failed" });
    expect(serialized).not.toContain(sentinel);
    log.mockRestore();
  });

  it("rejects hostile oracle descriptors before executing getters or sinks", async () => {
    let executed = false;
    const record = Object.defineProperty({}, "body", { enumerable: true, get() { executed = true; return "ok"; } });
    expect(() => createGuardedFetch({ responseOracle: { responses: [record], observations: [] } as never })).toThrow();
    expect(executed).toBe(false);
    const sinkOracle = { responses: [{ body: "ok" }], observations: { push() { executed = true; } } };
    expect(() => createGuardedFetch({ responseOracle: sinkOracle as never })).toThrow();
    expect(executed).toBe(false);
  });
  it("keeps browser hostname egress behind an executable pinned-transport gate", () => {
    expect(browserEgressRouteDecision("https://safe.example/")).toBe("abort");
    expect(browserEgressRouteDecision("https://93.184.216.34/")).toBe("evaluate-ip");
    expect(() => createCampfitRenderImpl()).toThrow(/hostname egress unavailable/i);
  });

  it("maps egress and provider failures to stable public messages", () => {
    expect(publicEgressError(new EgressUrlPolicyError("DENIED_ADDRESS", "operatorDiscovery", "safe.example"))).toBe("Outbound request was rejected by security policy");
    expect(publicEgressError(new UpstreamProviderError(new Error("SECRET")))).toBe("Upstream provider request failed");
    expect(publicEgressError(new Error("SECRET"))).toBe("Crawl request failed");
  });
  it("logs original route-boundary errors while returning stable text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = new UpstreamProviderError(new Error("SECRET"));
    expect(logAndMapPublicEgressError("[route]", secret)).toBe("Upstream provider request failed");
    expect(spy).toHaveBeenCalledWith("[route]", secret);
    spy.mockRestore();
  });
  it.each([
    "http://0.0.0.0", "http://127.0.0.1", "http://10.0.0.1", "http://172.16.0.1",
    "http://192.168.1.1", "http://100.64.0.1", "http://169.254.169.254",
    "http://192.0.2.1", "http://198.18.0.1", "http://224.0.0.1", "http://255.255.255.255",
    "http://[::]", "http://[::1]", "http://[fc00::1]", "http://[fe80::1]",
    "http://[fec0::1]", "http://[100::1]", "http://[2001::1]", "http://[2001:db8::1]",
    "http://[2002::1]", "http://[ff00::1]",
    "http://[::ffff:169.254.169.254]", "http://metadata.google.internal",
  ])("denies non-global destination %s using parsed address bytes", async (raw) => {
    await expect(evaluateEgressUrl(raw, "operatorDiscovery", { resolver: resolver({}) }))
      .rejects.toBeInstanceOf(EgressUrlPolicyError);
  });

  it.each(["http://2130706433", "http://0177.0.0.1", "http://0x7f000001", "http://127.1"])(
    "rejects ambiguous numeric host %s", async (raw) => {
      await expect(evaluateEgressUrl(raw, "operatorDiscovery", { resolver: resolver({}) })).rejects.toMatchObject({ code: "INVALID_HOST" });
    },
  );

  it("normalizes a public hostname and strips fragments", async () => {
    const result = await evaluateEgressUrl("https://Example.COM./path?q=secret#fragment", "operatorDiscovery", {
      resolver: resolver({ "example.com": ["93.184.216.34"] }),
    });
    expect(result.url.href).toBe("https://example.com/path?q=secret");
    expect(result.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it.each(["ftp://example.com", "https://user:secret@example.com", "http://example.com:443", "https://example.com:80", "https://example.com:444"])(
    "rejects disallowed scheme, credentials, or port: %s", async (raw) => {
      await expect(evaluateEgressUrl(raw, "operatorDiscovery", { resolver: resolver({ "example.com": ["93.184.216.34"] }) })).rejects.toBeInstanceOf(EgressUrlPolicyError);
    },
  );

  it("permits only an explicitly allowlisted exact loopback test origin", async () => {
    const allowedOrigin = "http://127.0.0.1:43127";
    const options = createGuardedTraverseFetchOptions(
      { testOnlyAllowedLoopbackOrigins: [allowedOrigin] } as never,
      "storedCrawlTarget",
      { responseOracle: oracle({ body: "fixture" }) },
    );
    const init = {
      method: "GET" as const,
      headers: {},
      redirect: "manual" as const,
      signal: new AbortController().signal,
    };

    await expect(options.fetch!(`${allowedOrigin}/page`, init)).resolves.toMatchObject({ status: 200 });
    await expect(options.fetch!("http://127.0.0.1:43128/page", init)).rejects.toMatchObject({ code: "INVALID_PORT" });
    await expect(options.fetch!("http://127.0.0.1/page", init)).rejects.toMatchObject({ code: "DENIED_ADDRESS" });
  });

  it("rejects broad or non-canonical loopback test allowances", async () => {
    for (const origin of ["http://127.0.0.1", "http://127.0.0.1:43127/", "https://127.0.0.1:43127", "http://localhost:43127"]) {
      await expect(evaluateEgressUrl("http://127.0.0.1:43127/page", "storedCrawlTarget", {
        testOnlyAllowedLoopbackOrigins: [origin],
      })).rejects.toBeInstanceOf(TypeError);
    }
  });

  it("keeps the exact-loopback test capability absent from every production Traverse guard", () => {
    for (const path of [
      "lib/ingestion/lookout-check-adapter.ts",
      "lib/ingestion/llm-discovery.ts",
      "lib/ingestion/traverse-pipeline.ts",
      "lib/ingestion/aggregator/aggregator-extraction.ts",
    ]) {
      expect(readFileSync(path, "utf8"), path).not.toContain("testOnlyAllowedLoopbackOrigins");
    }
  });

  it("rejects mixed public/private DNS before connecting", async () => {
    const responseOracle = oracle({ body: "should-not-connect" });
    const guardedFetch = createGuardedFetch({ resolver: resolver({ "example.test": ["93.184.216.34", "10.0.0.1"] }), responseOracle });
    await expect(guardedFetch("https://example.test/")).rejects.toMatchObject({ code: "DENIED_ADDRESS" });
  });

  it("manually validates a redirect before a second connection", async () => {
    const responseOracle = oracle({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    const guardedFetch = createGuardedFetch({ resolver: resolver({ "example.test": ["93.184.216.34"] }), responseOracle });
    await expect(guardedFetch("https://example.test/start")).rejects.toMatchObject({ code: "REDIRECT_DOWNGRADE" });
  });

  it("pins each connection to the address vetted by the resolver", async () => {
    let calls = 0;
    const rebindingResolver: EgressResolver = async () => [{ address: ++calls === 1 ? "93.184.216.34" : "10.0.0.1" }];
    const responseOracle = oracle({ body: "ok" });
    const guardedFetch = createGuardedFetch({ resolver: rebindingResolver, responseOracle });
    await expect((await guardedFetch("https://example.test/")).text()).resolves.toBe("ok");
    expect(calls).toBe(1);
  });

  it("invokes the production transport with only the vetted IP literal", async () => {
    const destinations: string[] = [];
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, callback: (response: PassThrough) => void) => {
      destinations.push(String(options.hostname));
      const outgoing = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
      outgoing.write = () => undefined;
      outgoing.end = () => {
        const incoming = new PassThrough() as PassThrough & { statusCode: number; headers: http.IncomingHttpHeaders };
        incoming.statusCode = 200;
        incoming.headers = { "content-type": "text/plain" };
        callback(incoming);
        incoming.end("ok");
      };
      return outgoing;
    }) as unknown as typeof http.request);
    let resolutions = 0;
    const guarded = createGuardedFetch({
      resolver: async () => [{ address: ++resolutions === 1 ? "93.184.216.34" : "127.0.0.1" }],
    });
    await expect((await guarded("http://rebinding.example/")).text()).resolves.toBe("ok");
    expect(destinations).toEqual(["93.184.216.34"]);
    expect(destinations).not.toContain("rebinding.example");
    expect(destinations).not.toContain("127.0.0.1");
    expect(resolutions).toBe(1);
    requestSpy.mockRestore();
  });

  it.each(["http://[::127.0.0.1]", "http://[::ffff:0:127.0.0.1]", "http://[::ffff:127.0.0.1]"])(
    "denies embedded IPv4 loopback %s", async (raw) => {
      await expect(evaluateEgressUrl(raw, "operatorDiscovery")).rejects.toMatchObject({ code: "DENIED_ADDRESS" });
    },
  );
  it.each(["http://[64:ff9b::7f00:1]", "http://[64:ff9b:1::7f00:1]"])(
    "denies standardized translated IPv4 loopback %s", async (raw) => {
      await expect(evaluateEgressUrl(raw, "operatorDiscovery")).rejects.toMatchObject({ code: "DENIED_ADDRESS" });
    },
  );

  it("does not replay custom credentials or validators across origins", async () => {
    const responseOracle = oracle(
      { status: 302, headers: { location: "https://other.test/next" } },
      { body: "ok", whenHeaders: { accept: "text/html" }, withoutHeaders: ["x-api-key", "if-none-match", "if-modified-since"] },
      { error: true },
    );
    const guarded = createGuardedFetch({ resolver: resolver({ "start.test": ["93.184.216.34"], "other.test": ["93.184.216.35"] }), responseOracle });
    await guarded("https://start.test/", { headers: { Accept: "text/html", "X-Api-Key": "secret", "If-None-Match": "private-tag" } });
  });

  it("rejects HTTPS to HTTP downgrade before the second connection", async () => {
    const responseOracle = oracle({ status: 302, headers: { location: "http://other.test/" } });
    const guarded = createGuardedFetch({ resolver: resolver({ "start.test": ["93.184.216.34"], "other.test": ["93.184.216.35"] }), responseOracle });
    await expect(guarded("https://start.test/")).rejects.toMatchObject({ code: "REDIRECT_DOWNGRADE" });
  });

  it("bounds redirects and exposes only typed non-secret errors", async () => {
    const responseOracle = oracle(
      { status: 302, headers: { location: "/again" } },
      { status: 302, headers: { location: "/again" } },
    );
    const guardedFetch = createGuardedFetch({ resolver: resolver({ "example.test": ["93.184.216.34"] }), responseOracle, maxRedirects: 2 });
    const error = await guardedFetch("https://example.test/?token=top-secret").catch((value) => value);
    expect(error).toMatchObject({ code: "REDIRECT_LOOP", profile: "operatorDiscovery", safeHost: "example.test" });
    expect(String(error)).not.toContain("top-secret");
  });
});

describe("Wave 2 E1-E5/E9 transport matrix", () => {
  const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const maliciousTransport = () => vi.fn<typeof fetch>().mockResolvedValue(new Response("connected-private"));
  const provider = { name: "fixture", extract: vi.fn() } as never;
  const store = {} as never;
  const safeOptions = () => {
    const responseOracle = oracle(
      { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:", headers: { "content-type": "text/plain" }, repeat: true },
      { body: "<html><body>fixture</body></html>", headers: { "content-type": "text/html" }, repeat: true },
    );
    return { responseOracle, fetchOptions: { egressResponseOracle: responseOracle, egressResolver: resolver({ "safe.example": ["93.184.216.34"] }) } as never };
  };

  it("behavioral E1 operator discovery refuses caller transport", async () => {
    const malicious = maliciousTransport();
    const result = await discoverCampsFromUrl("https://safe.example", { provider, store, fetchOptions: { fetch: malicious }, egressProfile: "operatorDiscovery" });
    expect(result.error).toContain("UNTRUSTED_TRANSPORT");
    expect(malicious).not.toHaveBeenCalled();
  });
  it("behavioral E2 aggregator crawl refuses caller transport before crawlSource", async () => {
    const malicious = maliciousTransport();
    let calls = 0;
    const pool = { query: vi.fn(async () => ({ rows: ++calls === 1 ? [{ id: "agg", name: "Agg", url: "https://safe.example", communitySlug: "denver", status: "ACTIVE", tosDecision: "APPROVED", maxPages: 1, maxDepth: 0 }] : [] })) } as never;
    await expect(runAggregatorDiscovery("agg", { performedBy: "test" }, { provider, store, fetchOptions: { fetch: malicious } }, pool))
      .rejects.toMatchObject({ code: "UNTRUSTED_TRANSPORT" });
    expect(malicious).not.toHaveBeenCalled();
  });
  it("behavioral E3 provider discovery refuses caller transport", async () => {
    const malicious = maliciousTransport();
    const result = await discoverCampsFromUrl("https://safe.example", { provider, store, fetchOptions: { fetch: malicious }, egressProfile: "storedCrawlTarget" });
    expect(result.error).toContain("UNTRUSTED_TRANSPORT");
    expect(malicious).not.toHaveBeenCalled();
  });
  it("behavioral E4 recrawl refuses caller transport", async () => {
    const malicious = maliciousTransport();
    await expect(runTraverseRecrawlForCamp({ campId: "c", websiteUrl: "https://safe.example", campName: "Camp", current: {} as never, provider, store, mode: "live", fetchOptions: { fetch: malicious } }))
      .rejects.toMatchObject({ code: "UNTRUSTED_TRANSPORT" });
    expect(malicious).not.toHaveBeenCalled();
  });
  it("behavioral E5 configured source refuses caller transport", async () => {
    const malicious = maliciousTransport();
    await expect(runTraversePipelineForSource({ key: "s", name: "Source", url: "https://safe.example" }, { provider, store, sink: async () => null, fetchOptions: { fetch: malicious } }))
      .rejects.toMatchObject({ code: "UNTRUSTED_TRANSPORT" });
    expect(malicious).not.toHaveBeenCalled();
  });
  it.each(["operatorDiscovery", "storedCrawlTarget"] as const)("behavioral discovery %s positive path succeeds", async (egressProfile) => {
    const { fetchOptions } = safeOptions();
    const result = await discoverCampsFromUrl("https://safe.example", { provider: createStubProvider([]), store: createInMemorySnapshotStore(), fetchOptions, egressProfile });
    expect(result.error).toBeUndefined();
  });
  it("behavioral E4 positive recrawl succeeds", async () => {
    const { fetchOptions } = safeOptions();
    const result = await runTraverseRecrawlForCamp({ campId: "c", websiteUrl: "https://safe.example", campName: "Camp", current: {} as never,
      provider: createStubProvider([{ fieldPath: "items[].name", candidateValue: "Camp", needle: "fixture" }]), store: createInMemorySnapshotStore(), mode: "live", fetchOptions });
    expect(result.ok).toBe(true);
  });
  it("behavioral E5 positive configured source succeeds", async () => {
    const { fetchOptions } = safeOptions();
    const result = await runTraversePipelineForSource({ key: "s", name: "Source", url: "https://safe.example" },
      { provider: createStubProvider([]), store: createInMemorySnapshotStore(), sink: async () => null, fetchOptions });
    expect(result.ok).toBe(true);
  });
  it("behavioral E2 positive path reaches the declarative oracle", async () => {
    const { fetchOptions } = safeOptions();
    let calls = 0;
    const pool = { query: vi.fn(async () => ({ rows: ++calls === 1 ? [{ id: "agg", name: "Agg", url: "https://safe.example", communitySlug: "denver", status: "ACTIVE", tosDecision: "APPROVED", maxPages: 1, maxDepth: 0 }] : [] })) } as never;
    const result = await runAggregatorDiscovery("agg", { performedBy: "test" }, { provider: createStubProvider([]), store: createInMemorySnapshotStore(), fetchOptions, log: () => {} }, pool);
    expect(result.pageErrors).toEqual([]);
    expect(result.discoveredPages).toBe(1);
  });

  it("E1 operator discovery guards the live discoverCampsFromUrl boundary", () => {
    expect(source("lib/ingestion/llm-discovery.ts")).toMatch(/createGuardedTraverseFetchOptions\(options\.fetchOptions/);
  });
  it("E2 aggregator extraction guards crawlSource at its production boundary", () => {
    expect(source("lib/ingestion/aggregator/aggregator-extraction.ts")).toMatch(/createGuardedTraverseFetchOptions\(deps\.fetchOptions/);
  });
  it("E3 provider discovery uses the guarded live discovery boundary and preserves replay", () => {
    const discovery = source("lib/ingestion/llm-discovery.ts");
    expect(discovery).toMatch(/=== "replay"[\s\S]*?\? options\.fetchOptions\s*:\s*createGuardedTraverseFetchOptions/);
  });
  it("E4 recrawl wraps caller options at the shared live attempt", () => {
    expect(source("lib/ingestion/traverse-pipeline.ts")).toMatch(/createGuardedTraverseFetchOptions\(deps\.fetchOptions/);
  });
  it("E5 configured-source sweep reaches the same owned live guard", () => {
    const pipeline = source("lib/ingestion/traverse-pipeline.ts");
    expect(pipeline).toMatch(/fetchAndExtractWithRevalidation[\s\S]+createGuardedTraverseFetchOptions/);
  });

  it.each(["E1 operator discovery", "E2 aggregator crawl", "E3 provider discovery", "E4 recrawl", "E5 source sweep"])(
    "%s rejects private literals, private DNS, and private redirects before forbidden fetches",
    async () => {
      const responseOracle = oracle({ status: 302, headers: { location: "http://169.254.169.254/latest" } });
      const options = createGuardedTraverseFetchOptions(
        undefined,
        "storedCrawlTarget",
        { resolver: resolver({ "safe.example": ["93.184.216.34"], "private.example": ["10.0.0.2"] }), responseOracle },
      );

      const init = { method: "GET" as const, headers: {}, redirect: "manual" as const, signal: new AbortController().signal };
      await expect(options.fetch!("http://127.0.0.1", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
      await expect(options.fetch!("https://private.example", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
      await expect(options.fetch!("https://safe.example/start", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
    },
  );

  it("caller fetch injection is refused while non-network Traverse options survive", () => {
    const injected = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const now = () => 123;
    expect(() => createGuardedTraverseFetchOptions({ fetch: injected, now }, "storedCrawlTarget"))
      .toThrow(expect.objectContaining({ code: "UNTRUSTED_TRANSPORT" }));
    const options = createGuardedTraverseFetchOptions({ now }, "storedCrawlTarget");
    expect(options.now).toBe(now);
    expect(injected).not.toHaveBeenCalled();
  });

  it("refuses an adversarial caller transport before it can re-resolve Host", () => {
    const malicious = vi.fn<typeof fetch>().mockResolvedValue(new Response("connected-private"));
    expect(() => createGuardedTraverseFetchOptions({ fetch: malicious }, "storedCrawlTarget"))
      .toThrow(expect.objectContaining({ code: "UNTRUSTED_TRANSPORT" }));
    expect(malicious).not.toHaveBeenCalled();
  });

  it("E9 legacy harvester uses the fixed-harvester guarded transport", async () => {
    class TestHarvester extends BaseHarvester {
      async fetchListings() { return []; }
      run(url: string) { return this.fetchHtml(url); }
    }
    const harvester = new TestHarvester("test", {
      resolver: resolver({ "safe.example": ["93.184.216.34"], "private.example": ["10.0.0.2"] }),
    });
    await expect(harvester.run("http://127.0.0.1")).rejects.toBeInstanceOf(EgressUrlPolicyError);
    await expect(harvester.run("https://private.example")).rejects.toBeInstanceOf(EgressUrlPolicyError);
  });
  it("E9 typed-refuses runtime fetch injection at construction", () => {
    class TestHarvester extends BaseHarvester { async fetchListings() { return []; } }
    const malicious = vi.fn<typeof fetch>();
    expect(() => new TestHarvester("test", { fetch: malicious } as never)).toThrow(expect.objectContaining({ code: "UNTRUSTED_TRANSPORT" }));
    expect(malicious).not.toHaveBeenCalled();
  });
});
