/**
 * test-render-fetch.ts — proof for `render: true` (Playwright headless
 * fetch) in the traverse ingestion pipeline (issue #41).
 *
 * Uses a tiny local HTTP server (no external network) serving pages whose
 * content is injected by client-side script after load — exactly the shape
 * of a JS-rendered SPA whose plain fetch() returns an empty shell.
 *
 * Covers:
 *  1. `renderPage()` (the low-level render primitive, lib/ingestion/render-fetch.ts)
 *     waits for client-side hydration: a plain `fetch()` of the page misses
 *     the hydrated content; `renderPage()`'s result contains it, with
 *     `usedNetworkidleFallback: false` for a page that settles normally.
 *  2. `renderPage()` falls back from `networkidle` to `domcontentloaded`
 *     when a pending request never resolves (a long-poll-style page that
 *     never goes fully idle) — `usedNetworkidleFallback` is true and the
 *     already-parsed DOM content is still returned.
 *  3. End-to-end pipeline wiring: an `IngestionSourceConfig` with
 *     `render: true` run through `runTraversePipelineForSource` extracts a
 *     field from content that only exists AFTER client-side hydration —
 *     proving the rendered HTML flows into the EXACT SAME fetch->extract
 *     pipeline a plain-fetch source uses today (same snapshot capture, same
 *     schema-directed extraction), with render telemetry on the result.
 *  4. Per-source isolation at the pipeline level: a `render: true` source
 *     whose target never responds at all times out and fails ONLY that
 *     source (`ok: false`, no throw) — a healthy source (rendered or not)
 *     later in the same sweep still runs, reusing the same shared browser
 *     instance. Mirrors the existing dead-source isolation contract in
 *     scripts/test-traverse-replay.ts's `testPipelineFailureIsolation`.
 *
 * Requires Playwright's Chromium browser to be installed locally
 * (`npx playwright install chromium`) — already provisioned for this repo's
 * browser test suite (see .github/workflows/ci.yml's `npx playwright
 * install --with-deps chromium` step) and installed by the
 * `render_fetch_proof` CI job added alongside this test.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { renderPage, closeRenderBrowser, DEFAULT_RENDER_TIMEOUT_MS } from "../lib/ingestion/render-fetch";
import {
  runTraversePipelineForSource,
  runTraversePipeline,
  type TraverseProposalSink,
} from "../lib/ingestion/traverse-pipeline";
import { createInMemorySnapshotStore } from "@kontourai/traverse/fetch";
import { createStubProvider, StubProposalSpec } from "../tests/fixtures/traverse/stub-provider";
import type { IngestionSourceConfig } from "../lib/ingestion/sources";

// ─── Tiny local fixture server ──────────────────────────────────────────
//
// Routes:
//  /spa-page   — empty-shell HTML that hydrates `#content` via a same-origin
//                fetch() to /data.json (mimics a real SPA's async hydration).
//  /data.json  — the "API response" the page's script fetches.
//  /hang-page  — HTML that starts a fetch() to /never-responds, whose
//                connection is accepted but NEVER answered — the page never
//                reaches `networkidle`, exercising the domcontentloaded
//                fallback.
//  /dead-page  — accepts the connection and never writes ANY bytes back, so
//                neither `networkidle` nor `domcontentloaded` ever fires —
//                exercises the hard per-source timeout / isolation path.
//  anything else (incl. /robots.txt) — 404, handled as "no restrictions" by
//                fetchSource's fail-open robots handling.

const HYDRATED_MARKER = "REND" + "EREDMARKERXYZ"; // built at runtime — see assertion below
// No "_"/"*"/"[" etc: traverse 0.5.0+ prepares HTML as Markdown by default
// (Turndown), which backslash-escapes markdown-special characters in text
// nodes (e.g. "A_B" -> "A\\_B") — a real LLM provider naturally echoes the
// text it was shown (escapes and all) as its verbatim excerpt, so this is a
// non-issue for a real provider, but this file's stub uses the ORIGINAL
// marker string as both the excerpt needle and the field value, so an
// escaped character here would make the needle search miss the prepared
// text and the proposal would be (correctly) dropped as unverifiable —
// alnum-only sidesteps that stub simplification entirely.

function startFixtureServer(): Promise<{ baseUrl: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";

    if (url === "/spa-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html>
<html><body>
<div id="content">EMPTY_SHELL</div>
<script>
fetch('/data.json').then(function (r) { return r.json(); }).then(function (d) {
  document.getElementById('content').textContent = d.marker;
});
</script>
</body></html>`);
      return;
    }

    if (url === "/data.json") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ marker: HYDRATED_MARKER }));
      }, 30);
      return;
    }

    if (url === "/hang-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html>
<html><body>
<div id="content">HANG_SHELL</div>
<script>fetch('/never-responds').catch(function () {});</script>
</body></html>`);
      return;
    }

    if (url === "/never-responds") {
      // Accept the connection; never write a response — keeps this request
      // "in flight" forever from the page's perspective.
      return;
    }

    if (url === "/dead-page") {
      // Accept the connection; never write ANY bytes (not even headers) —
      // navigation itself never resolves.
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

// ─── 1. renderPage() sees hydrated content a plain fetch misses ─────────

async function testRenderSeesHydratedContentPlainFetchMisses(baseUrl: string) {
  const pageUrl = `${baseUrl}/spa-page`;

  const plainRes = await fetch(pageUrl);
  const plainHtml = await plainRes.text();
  assert.ok(
    !plainHtml.includes(HYDRATED_MARKER),
    "a plain fetch() must NOT see content injected by client-side script"
  );
  assert.ok(plainHtml.includes("EMPTY_SHELL"), "plain fetch should see the unhydrated shell");

  const rendered = await renderPage(pageUrl, DEFAULT_RENDER_TIMEOUT_MS);
  assert.ok(
    rendered.html.includes(HYDRATED_MARKER),
    "renderPage() must see content hydrated by client-side script after load"
  );
  assert.equal(rendered.usedNetworkidleFallback, false, "a normally-settling page should not need the fallback");
  assert.ok(rendered.durationMs >= 0);

  console.log("✓ renderPage() sees client-side-hydrated content that a plain fetch() misses");
}

// ─── 2. networkidle → domcontentloaded fallback ──────────────────────────

async function testNetworkidleFallback(baseUrl: string) {
  const pageUrl = `${baseUrl}/hang-page`;
  // Short timeout: the pending /never-responds fetch means networkidle can
  // never resolve, so this always exercises the fallback — keeps the test
  // fast without being flaky.
  const rendered = await renderPage(pageUrl, 800);

  assert.equal(rendered.usedNetworkidleFallback, true, "a page with a perpetually-pending request must fall back");
  assert.ok(rendered.html.includes("HANG_SHELL"), "the fallback should still return the already-parsed DOM content");

  console.log("✓ renderPage() falls back to domcontentloaded when networkidle never resolves, and still returns content");
}

// ─── 3. End-to-end: render flows into the traverse pipeline unchanged ───

async function testRenderFlowsIntoTraversePipeline(baseUrl: string) {
  const source: IngestionSourceConfig = {
    key: "test-render-spa",
    name: "Render SPA Source",
    url: `${baseUrl}/spa-page`,
    render: true,
  };

  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: HYDRATED_MARKER, needle: HYDRATED_MARKER },
  ];

  const routed: string[] = [];
  const sink: TraverseProposalSink = async (record) => {
    routed.push(record.itemName);
    return `proposal-${routed.length}`;
  };

  const result = await runTraversePipelineForSource(source, {
    provider: createStubProvider(specs, { model: "stub-render" }),
    store: createInMemorySnapshotStore(),
    sink,
    mode: "live-with-capture",
    log: () => {},
  });

  assert.equal(result.ok, true, `expected ok=true, got fetchError=${result.fetchError} extractionError=${result.extractionError}`);
  assert.equal(result.itemCount, 1, "the stub proposal (built from hydrated content) must survive extraction");
  assert.deepEqual(routed, [HYDRATED_MARKER], "the item routed to the sink must be the client-side-hydrated value");
  assert.ok(result.render, "a render: true source's result must carry render telemetry");
  assert.equal(result.render!.usedNetworkidleFallback, false);
  assert.ok(result.snapshotBodyHash, "the rendered HTML must still be captured to the snapshot store like any other fetch");

  console.log("✓ render: true flows the rendered HTML into the SAME fetch->extract->route pipeline, with render telemetry on the result");
}

// ─── 4. Per-source isolation: a render timeout fails only that source ──

async function testRenderTimeoutIsolatesFailureAndSweepContinues(baseUrl: string) {
  const deadSource: IngestionSourceConfig = {
    key: "test-render-dead",
    name: "Dead Render Source",
    url: `${baseUrl}/dead-page`,
    render: true,
    // Short hard timeout — /dead-page never responds at all, so this always
    // times out on BOTH the networkidle attempt and the domcontentloaded
    // retry; keeping it short keeps the isolation test fast.
    renderTimeoutMs: 400,
  };
  const healthySource: IngestionSourceConfig = {
    key: "test-render-healthy",
    name: "Healthy Render Source",
    url: `${baseUrl}/spa-page`,
    render: true,
  };

  const routed: string[] = [];
  const sink: TraverseProposalSink = async (record) => {
    routed.push(record.itemName);
    return `proposal-${routed.length}`;
  };

  const results = await runTraversePipeline([deadSource, healthySource], {
    provider: createStubProvider(
      [{ fieldPath: "items[].name", candidateValue: HYDRATED_MARKER, needle: HYDRATED_MARKER }],
      { model: "stub-render-isolation" }
    ),
    store: createInMemorySnapshotStore(),
    sink,
    mode: "live-with-capture",
    log: () => {},
  });

  assert.equal(results.length, 2, "both sources should have been attempted despite the render timeout");

  assert.equal(results[0].ok, false, "a render timeout must fail only that source");
  assert.equal(results[0].itemCount, 0);
  assert.ok(results[0].fetchError, "the render timeout must surface as a fetch error, exactly like any other fetch failure");
  assert.equal(results[0].render, undefined, "no render telemetry when the render itself never completed");

  assert.equal(results[1].ok, true, "the source after a render timeout must still run — reusing the same shared browser");
  assert.equal(results[1].itemCount, 1);
  assert.deepEqual(routed, [HYDRATED_MARKER], "only the healthy source's item reached the sink");

  console.log("✓ a render timeout isolates only that source; the sweep continues to the next (rendered) source via the same shared browser");
}

// ─── Run ─────────────────────────────────────────────────────────────────

async function main() {
  const { baseUrl, server } = await startFixtureServer();
  try {
    await testRenderSeesHydratedContentPlainFetchMisses(baseUrl);
    await testNetworkidleFallback(baseUrl);
    await testRenderFlowsIntoTraversePipeline(baseUrl);
    await testRenderTimeoutIsolatesFailureAndSweepContinues(baseUrl);
  } finally {
    await closeRenderBrowser();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("\nrender-fetch verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
