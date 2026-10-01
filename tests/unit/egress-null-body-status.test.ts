/**
 * The guarded egress connector against a real local HTTP server: the socket
 * path a live crawl uses, not the fixture oracle.
 *
 * A 304 to a conditional GET used to throw inside the response's "end"
 * handler (`new Response(body, { status: 304 })` is a TypeError), which is an
 * uncaught exception in an event callback: the fetch promise never settled and
 * the crawl run stayed RUNNING. These tests fail by timing out if that returns.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { buildEgressResponse, createGuardedFetch, EgressUrlPolicyError } from "@/lib/security/egress-url-policy";

const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<{ origin: string; fetch: typeof fetch }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, fetch: createGuardedFetch({ profile: "storedCrawlTarget", testOnlyAllowedLoopbackOrigins: [origin] }) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
});

describe("guarded egress connector: null-body statuses and failures settle the request", () => {
  it("resolves a 304 to a conditional GET with a null body", async () => {
    const seen: (string | undefined)[] = [];
    const { origin, fetch } = await serve((req, res) => {
      seen.push(req.headers["if-none-match"]);
      res.writeHead(304, { etag: 'W/"3fc966c931fdf24033565bc7bb636ea5"' });
      res.end();
    });

    const response = await fetch(`${origin}/dates-rates`, { headers: { "If-None-Match": 'W/"3fc966c931fdf24033565bc7bb636ea5"' } });

    expect(seen).toEqual(['W/"3fc966c931fdf24033565bc7bb636ea5"']);
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('W/"3fc966c931fdf24033565bc7bb636ea5"');
  }, 5_000);

  it.each([204, 205])("resolves a %i", async (status) => {
    const { origin, fetch } = await serve((_req, res) => { res.writeHead(status); res.end(); });
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  }, 5_000);

  it("gives every null-body status a null body even when bytes arrived", () => {
    for (const status of [204, 205, 304]) {
      const response = buildEgressResponse(status, undefined, Buffer.from("unexpected body"));
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
    expect(buildEgressResponse(200, undefined, Buffer.from("page")).body).not.toBeNull();
  });

  it("rejects, instead of hanging, when the response cannot be built", async () => {
    // 600 is a status the Fetch Response constructor refuses outright (it
    // accepts 200-599), so building the response throws in the "end" handler.
    const { origin, fetch } = await serve((_req, res) => { res.writeHead(600); res.end("nope"); });
    await expect(fetch(`${origin}/`)).rejects.toBeInstanceOf(EgressUrlPolicyError);
  }, 5_000);

  it("rejects when the upstream closes mid-body", async () => {
    const { origin, fetch } = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 20);
    });
    await expect(fetch(`${origin}/`)).rejects.toBeInstanceOf(EgressUrlPolicyError);
  }, 5_000);

  it("rejects when the caller's timeout aborts a stalled upstream", async () => {
    const { origin, fetch } = await serve(() => { /* never answers */ });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await expect(fetch(`${origin}/`, { signal: controller.signal })).rejects.toBeInstanceOf(EgressUrlPolicyError);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);
});
