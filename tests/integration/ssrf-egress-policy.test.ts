import { describe, expect, it, vi } from "vitest";

import {
  EgressUrlPolicyError,
  createGuardedFetch,
  createGuardedTraverseFetchOptions,
  evaluateEgressUrl,
  type EgressConnector,
  type EgressResolver,
} from "@/lib/security/egress-url-policy";
import { BaseHarvester } from "@/lib/ingestion/aggregator/base-harvester";

const resolver = (answers: Record<string, string[]>): EgressResolver => async (hostname) =>
  (answers[hostname] ?? []).map((address) => ({ address }));

describe("server egress URL policy threat matrix", () => {
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

  it("rejects mixed public/private DNS before connecting", async () => {
    const connector = vi.fn<EgressConnector>();
    const guardedFetch = createGuardedFetch({ resolver: resolver({ "example.test": ["93.184.216.34", "10.0.0.1"] }), connector });
    await expect(guardedFetch("https://example.test/")).rejects.toMatchObject({ code: "DENIED_ADDRESS" });
    expect(connector).not.toHaveBeenCalled();
  });

  it("manually validates a redirect before a second connection", async () => {
    const connector = vi.fn<EgressConnector>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    const guardedFetch = createGuardedFetch({ resolver: resolver({ "example.test": ["93.184.216.34"] }), connector });
    await expect(guardedFetch("https://example.test/start")).rejects.toMatchObject({ code: "DENIED_ADDRESS" });
    expect(connector).toHaveBeenCalledTimes(1);
  });

  it("pins each connection to the address vetted by the resolver", async () => {
    let calls = 0;
    const rebindingResolver: EgressResolver = async () => [{ address: ++calls === 1 ? "93.184.216.34" : "10.0.0.1" }];
    const connector = vi.fn<EgressConnector>().mockResolvedValue(new Response("ok"));
    const guardedFetch = createGuardedFetch({ resolver: rebindingResolver, connector });
    await expect((await guardedFetch("https://example.test/")).text()).resolves.toBe("ok");
    expect(connector).toHaveBeenCalledWith(expect.objectContaining({ address: { address: "93.184.216.34", family: 4 } }));
    expect(calls).toBe(1);
  });

  it("bounds redirects and exposes only typed non-secret errors", async () => {
    const connector = vi.fn<EgressConnector>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "/again" } }));
    const guardedFetch = createGuardedFetch({ resolver: resolver({ "example.test": ["93.184.216.34"] }), connector, maxRedirects: 2 });
    const error = await guardedFetch("https://example.test/?token=top-secret").catch((value) => value);
    expect(error).toMatchObject({ code: "REDIRECT_LOOP", profile: "operatorDiscovery", safeHost: "example.test" });
    expect(String(error)).not.toContain("top-secret");
  });
});

describe("Wave 2 E1-E5/E9 transport matrix", () => {
  it.each(["E1 operator discovery", "E2 aggregator crawl", "E3 provider discovery", "E4 recrawl", "E5 source sweep"])(
    "%s rejects private literals, private DNS, and private redirects before forbidden fetches",
    async () => {
      const underlying = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
      const options = createGuardedTraverseFetchOptions(
        { fetch: underlying },
        "storedCrawlTarget",
        { resolver: resolver({ "safe.example": ["93.184.216.34"], "private.example": ["10.0.0.2"] }) },
      );

      const init = { method: "GET" as const, headers: {}, redirect: "manual" as const, signal: new AbortController().signal };
      await expect(options.fetch!("http://127.0.0.1", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
      await expect(options.fetch!("https://private.example", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
      await expect(options.fetch!("https://safe.example/start", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
      expect(underlying).toHaveBeenCalledTimes(1);
    },
  );

  it("caller fetch injection is composed under the guard and other Traverse options survive", async () => {
    const injected = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const now = () => 123;
    const options = createGuardedTraverseFetchOptions(
      { fetch: injected, now },
      "storedCrawlTarget",
      { resolver: resolver({ "safe.example": ["93.184.216.34"] }) },
    );
    expect(options.now).toBe(now);
    const init = { method: "GET" as const, headers: {}, redirect: "manual" as const, signal: new AbortController().signal };
    await expect(options.fetch!("http://127.0.0.1", init)).rejects.toBeInstanceOf(EgressUrlPolicyError);
    expect(injected).not.toHaveBeenCalled();
    await expect((await options.fetch!("https://safe.example", init)).text()).resolves.toBe("ok");
  });

  it("E9 legacy harvester uses the fixed-harvester guarded transport", async () => {
    class TestHarvester extends BaseHarvester {
      async fetchListings() { return []; }
      run(url: string) { return this.fetchHtml(url); }
    }
    const injected = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const harvester = new TestHarvester("test", {
      fetch: injected,
      resolver: resolver({ "safe.example": ["93.184.216.34"], "private.example": ["10.0.0.2"] }),
    });
    await expect(harvester.run("http://127.0.0.1")).rejects.toBeInstanceOf(EgressUrlPolicyError);
    await expect(harvester.run("https://private.example")).rejects.toBeInstanceOf(EgressUrlPolicyError);
    expect(injected).not.toHaveBeenCalled();
    await expect(harvester.run("https://safe.example")).resolves.toBe("ok");
  });
});
