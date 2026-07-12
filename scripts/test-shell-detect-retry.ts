/**
 * test-shell-detect-retry.ts — proof for the shell-detection auto-retry seam
 * in lib/ingestion/traverse-pipeline.ts (closes campfit#41 follow-up /
 * kontourai/traverse#11, landed in @kontourai/traverse@0.6.0).
 *
 * Uses a tiny local HTTP server (no external network, no API key) serving
 * pages shaped to trip traverse's JS-shell-detection heuristic
 * (`detectJsShell` in @kontourai/traverse — an empty `<div id="root"></div>`
 * client-render mount is enough to trip `structuralShellSignal` regardless of
 * script ratio) — see node_modules/@kontourai/traverse/README.md's "SPA /
 * JS-rendered pages" section.
 *
 * The fixture server tells a plain HTTP GET (traverse's own `fetchSource`,
 * identifying as `CAMPFIT_FETCH_USER_AGENT`) apart from a headless-Chromium
 * render (lib/ingestion/render-fetch.ts's `RENDER_USER_AGENT`, which starts
 * with "Mozilla/5.0") purely by User-Agent — the same distinguishing signal
 * a real server would see — so the "render retry itself fails" fixture can
 * deterministically hang ONLY the render request while the plain fetch (the
 * first attempt, which must succeed for shell-detection to fire at all)
 * still gets a fast, normal response.
 *
 * Covers:
 *  1. Shell page (script-injected content via an empty `#root` mount): a
 *     plain fetch's extraction fires the pure `js-shell-suspected` warning;
 *     `runTraversePipelineForSource` auto-retries ONCE with
 *     `SourceConfig.render: true` (via a caller-injected `renderImpl` — the
 *     traverse 0.13.0 native rendered-fetch seam, campfit#53), and the
 *     RENDERED attempt's extraction recovers the hydrated marker the plain
 *     fetch could never see, with `Snapshot.rendered: true` on the result.
 *     `shellEscalation` records the escalation + both attempts' warnings/
 *     item counts.
 *  2. Downgraded-code page (empty `#root` mount, but a JSON-LD sidecar is
 *     present in the raw HTML): NO render fires; `embeddedStateAvailable`
 *     records the sidecar's presence/counts on the result.
 *  3. Retry-render-failure: the first (plain-fetch) attempt still extracts
 *     what it can see (partial results); the render retry hangs and times
 *     out; the FIRST attempt's results are kept and the failure is noted on
 *     `shellEscalation`.
 *  4. A `render: true` source never re-enters the retry seam — no
 *     `shellEscalation` is ever recorded for it, and it renders its page
 *     exactly once (never double-rendered).
 *  5. No renderer configured (campfit#53 Task 2.2's deliberate new
 *     behavior): a shell-suspected retry is SKIPPED entirely — never issued
 *     — when this run's `fetchOptions.renderImpl` is unset (every Vercel
 *     route today), since it would only ever produce traverse's own
 *     `invalid-config` FetchError. Recorded via
 *     `shellEscalation.retrySkippedNoRenderer`, distinct from a retry that
 *     was attempted and failed.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { closeRenderBrowser, createCampfitRenderImpl } from "../lib/ingestion/render-fetch";
import {
  runTraversePipelineForSource,
  type TraverseProposalSink,
} from "../lib/ingestion/traverse-pipeline";
import { createInMemorySnapshotStore } from "@kontourai/traverse/fetch";
import { createStubProvider, StubProposalSpec } from "../tests/fixtures/traverse/stub-provider";
import type { IngestionSourceConfig } from "../lib/ingestion/sources";

// ─── Tiny local fixture server ──────────────────────────────────────────
//
// Routes:
//  /shell-marker-page    — empty `#root` shell; hydrates `#root` via a
//                          same-origin fetch() to /shell-marker-data.json
//                          (mimics a real SPA's async hydration). Plain
//                          fetch sees only the empty shell (shell-suspected
//                          fires); a render sees the hydrated marker.
//  /shell-marker-data.json — the "API response" the page's script fetches.
//  /shell-embedded-page  — empty `#root` shell that ALSO carries a
//                          `<script type="application/ld+json">` block —
//                          the downgraded (embedded-state-available) case.
//  /shell-retry-fail-page — empty `#root` shell whose plain-fetch response
//                          is fast and normal, but whose RENDER (detected
//                          by User-Agent) hangs forever, so the render
//                          retry itself times out.
//  anything else (incl. /robots.txt) — 404, handled as "no restrictions" by
//                fetchSource's fail-open robots handling.

const HYDRATED_MARKER = "SHEL" + "LRETRYMARKERXYZ"; // alnum-only — see test-render-fetch.ts's note on markdown escaping
const RENDER_UA_PREFIX = "Mozilla/5.0"; // lib/ingestion/render-fetch.ts's RENDER_USER_AGENT starts with this; CAMPFIT_FETCH_USER_AGENT does not.
// Inert padding (an HTML comment, stripped before prepared text) so a page
// that ALSO carries some genuinely-visible text (e.g. a static <h1>) still
// clears traverse's textRatio<0.08 shell-detection gate — a real shell page
// is almost all markup/script around near-zero visible text; a small fixture
// page with only a couple of static words is naturally too text-DENSE
// relative to its own tiny raw-HTML size without this padding.
const SHELL_RATIO_PADDING = `<!-- ${"x".repeat(400)} -->`;

function isRenderRequest(req: http.IncomingMessage): boolean {
  return (req.headers["user-agent"] ?? "").startsWith(RENDER_UA_PREFIX);
}

function startFixtureServer(): Promise<{
  baseUrl: string;
  server: http.Server;
  renderRequestCounts: Map<string, number>;
}> {
  const renderRequestCounts = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";

    if (isRenderRequest(req)) {
      renderRequestCounts.set(url, (renderRequestCounts.get(url) ?? 0) + 1);
    }

    if (url === "/shell-marker-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html>
<html><body>
<h1>Static Title</h1>
<div id="root"></div>
<script>
fetch('/shell-marker-data.json').then(function (r) { return r.json(); }).then(function (d) {
  document.getElementById('root').innerHTML = '<p>' + d.marker + '</p>';
});
</script>
</body></html>`);
      return;
    }

    if (url === "/shell-marker-data.json") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ marker: HYDRATED_MARKER }));
      }, 30);
      return;
    }

    if (url === "/shell-embedded-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html>
<html><head>
<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Event",
        name: "Embedded Sidecar Camp",
      })}</script>
</head><body>
<div id="root"></div>
</body></html>`);
      return;
    }

    if (url === "/shell-retry-fail-page") {
      if (isRenderRequest(req)) {
        // Accept the connection; never write ANY bytes — the render
        // navigation itself never resolves (both the networkidle wait AND
        // the domcontentloaded fallback time out), so renderPage() throws.
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html>
<html><body>
${SHELL_RATIO_PADDING}
<h1>Static Title</h1>
<div id="root"></div>
</body></html>`);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server, renderRequestCounts });
    });
  });
}

// ─── 1. Shell page: auto-retry fires and the rendered attempt wins ──────

async function testShellDetectedAutoRetryRecoversMarker(baseUrl: string) {
  const source: IngestionSourceConfig = {
    key: "test-shell-marker",
    name: "Shell Marker Source",
    url: `${baseUrl}/shell-marker-page`,
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
    provider: createStubProvider(specs, { model: "stub-shell-retry" }),
    store: createInMemorySnapshotStore(),
    sink,
    mode: "live-with-capture",
    log: () => {},
    fetchOptions: {
      renderImpl: createCampfitRenderImpl({ testOnlyAllowedLoopbackOrigins: [baseUrl] }),
      testOnlyAllowedLoopbackOrigins: [baseUrl],
    } as never,
  });

  assert.equal(result.ok, true, `expected ok=true, got fetchError=${result.fetchError} extractionError=${result.extractionError}`);
  assert.ok(result.shellEscalation, "a plain fetch of an empty-#root shell must fire the shell-detection escalation");
  assert.equal(result.shellEscalation!.shellDetected, true);
  assert.equal(result.shellEscalation!.renderRetried, true);
  assert.equal(result.shellEscalation!.retrySkippedNoRenderer, undefined, "a renderImpl IS configured for this test — the retry must not be skipped");
  assert.equal(result.shellEscalation!.renderRetryFailed, false);
  assert.equal(result.shellEscalation!.firstAttemptItemCount, 0, "the plain-fetch attempt cannot see the marker, so it groups zero items");
  assert.equal(result.shellEscalation!.retryAttemptItemCount, 1, "the rendered retry recovers the hydrated marker as one item");
  assert.equal(result.shellEscalation!.renderImprovedProposalCount, true);
  assert.ok(
    result.shellEscalation!.firstAttemptWarnings.some((w) => w.startsWith("js-shell-suspected:")),
    "the first attempt's warnings must carry the pure js-shell-suspected code"
  );

  assert.equal(result.itemCount, 1, "the FINAL result reflects the rendered retry's recovered item");
  assert.deepEqual(routed, [HYDRATED_MARKER], "only the rendered retry's item is routed — the first attempt's (empty) items are never double-routed");
  // AC3 (campfit#53 spa-ingestion): a successful render retry must honestly
  // carry traverse's own Snapshot.rendered marker, same as a curated
  // render: true source.
  assert.equal(result.rendered, true, "a successful render retry must carry Snapshot.rendered: true");
  assert.ok(result.snapshotBodyHash, "the rendered HTML must still be captured to the snapshot store");
  assert.equal(result.embeddedStateAvailable, undefined, "no embedded state on this fixture — only the pure shell path fires");

  console.log("✓ js-shell-suspected auto-retries with a render and the rendered attempt's recovered marker wins (Snapshot.rendered: true, AC3)");
}

// ─── 2. Downgraded code: embedded state available, no render ───────────

async function testEmbeddedStateAvailableSkipsRender(baseUrl: string) {
  const source: IngestionSourceConfig = {
    key: "test-shell-embedded",
    name: "Shell Embedded-State Source",
    url: `${baseUrl}/shell-embedded-page`,
  };

  const result = await runTraversePipelineForSource(source, {
    provider: createStubProvider([], { model: "stub-shell-embedded" }),
    store: createInMemorySnapshotStore(),
    sink: async () => null,
    mode: "live-with-capture",
    log: () => {},
    fetchOptions: { testOnlyAllowedLoopbackOrigins: [baseUrl] } as never,
  });

  assert.equal(result.ok, true, `expected ok=true, got fetchError=${result.fetchError} extractionError=${result.extractionError}`);
  assert.equal(result.shellEscalation, undefined, "the downgraded code must NOT trigger a render retry");
  assert.equal(result.rendered, undefined, "no render should ever occur for the downgraded (embedded-state-available) case");
  assert.ok(result.embeddedStateAvailable, "the sidecar's presence must be recorded on the result");
  assert.equal(result.embeddedStateAvailable!.jsonLdCount, 1, "one JSON-LD block was harvested");
  assert.equal(result.embeddedStateAvailable!.hasNextData, false);
  assert.equal(result.embeddedStateAvailable!.hasInitialState, false);
  assert.ok(
    result.warnings.some((w) => w.startsWith("js-shell-suspected-embedded-state-available:")),
    "the downgraded warning code must still surface on result.warnings"
  );

  console.log("✓ js-shell-suspected-embedded-state-available skips the render and records the sidecar's presence/counts");
}

// ─── 3. Render retry fails: first attempt's (partial) results are kept ──

async function testRenderRetryFailureKeepsFirstAttempt(baseUrl: string) {
  const source: IngestionSourceConfig = {
    key: "test-shell-retry-fail",
    name: "Shell Retry-Fail Source",
    url: `${baseUrl}/shell-retry-fail-page`,
    // Short hard timeout: the render request to this fixture NEVER responds
    // at all, so this always times out on both the networkidle attempt and
    // the domcontentloaded fallback; keeping it short keeps the test fast.
    renderTimeoutMs: 400,
  };

  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: "Static Title", needle: "Static Title" },
  ];

  const routed: string[] = [];
  const sink: TraverseProposalSink = async (record) => {
    routed.push(record.itemName);
    return `proposal-${routed.length}`;
  };

  const result = await runTraversePipelineForSource(source, {
    provider: createStubProvider(specs, { model: "stub-shell-retry-fail" }),
    store: createInMemorySnapshotStore(),
    sink,
    mode: "live-with-capture",
    log: () => {},
    fetchOptions: {
      renderImpl: createCampfitRenderImpl({ testOnlyAllowedLoopbackOrigins: [baseUrl] }),
      testOnlyAllowedLoopbackOrigins: [baseUrl],
    } as never,
  });

  assert.equal(result.ok, true, `expected ok=true (first attempt succeeded), got fetchError=${result.fetchError} extractionError=${result.extractionError}`);
  assert.ok(result.shellEscalation, "the empty-#root shell must still be detected on the first attempt");
  assert.equal(result.shellEscalation!.shellDetected, true);
  assert.equal(result.shellEscalation!.renderRetried, true);
  assert.equal(result.shellEscalation!.retrySkippedNoRenderer, undefined, "a renderImpl IS configured — the retry must actually be attempted, not skipped");
  assert.equal(result.shellEscalation!.renderRetryFailed, true, "the render retry must be recorded as failed");
  assert.equal(result.shellEscalation!.firstAttemptItemCount, 1, "the first attempt still extracted the statically-visible title");
  assert.equal(result.shellEscalation!.retryAttemptItemCount, undefined, "no item count to report from a failed retry");
  assert.equal(result.shellEscalation!.renderImprovedProposalCount, undefined);

  assert.equal(result.itemCount, 1, "partial (first-attempt) results beat none — they are kept and routed");
  assert.deepEqual(routed, ["Static Title"], "the first attempt's item is routed since the render retry failed");
  assert.equal(result.rendered, undefined, "no rendered marker when the render retry never completed");
  assert.equal(result.fetchError, null, "the OVERALL result is not a fetch failure — the first attempt succeeded and was kept");

  console.log("✓ a failed render retry falls back to the first attempt's (partial) results, with the failure noted");
}

// ─── 4. A render: true source never double-retries ──────────────────────

async function testRenderTrueSourceNeverDoubleRetries(baseUrl: string, renderRequestCounts: Map<string, number>) {
  const source: IngestionSourceConfig = {
    key: "test-shell-render-true",
    name: "Already-Rendered Source",
    url: `${baseUrl}/shell-marker-page`,
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

  const before = renderRequestCounts.get("/shell-marker-page") ?? 0;

  const result = await runTraversePipelineForSource(source, {
    provider: createStubProvider(specs, { model: "stub-shell-render-true" }),
    store: createInMemorySnapshotStore(),
    sink,
    mode: "live-with-capture",
    log: () => {},
    fetchOptions: {
      renderImpl: createCampfitRenderImpl({ testOnlyAllowedLoopbackOrigins: [baseUrl] }),
      testOnlyAllowedLoopbackOrigins: [baseUrl],
    } as never,
  });

  const after = renderRequestCounts.get("/shell-marker-page") ?? 0;

  assert.equal(result.ok, true, `expected ok=true, got fetchError=${result.fetchError} extractionError=${result.extractionError}`);
  assert.equal(result.itemCount, 1, "the single render already recovers the marker");
  assert.deepEqual(routed, [HYDRATED_MARKER]);
  assert.equal(result.shellEscalation, undefined, "a render: true source must never enter the shell-retry seam");
  assert.equal(result.rendered, true, "render: true must honestly carry Snapshot.rendered: true");
  assert.equal(after - before, 1, "a render: true source must be rendered exactly ONCE, never double-rendered");

  console.log("✓ a render: true source never re-enters the shell-retry seam (rendered exactly once, Snapshot.rendered: true)");
}

// ─── 5. No renderer configured: shell suspected but retry is SKIPPED ────
//
// campfit#53 (spa-ingestion, Task 2.2's deliberate new behavior): every
// Vercel route today runs with no fetchOptions.renderImpl configured. A
// shell-suspected retry attempt in that context would only ever produce
// traverse's own invalid-config FetchError — so this seam skips the retry
// entirely rather than issuing a doomed attempt, and records that decision
// on shellEscalation.retrySkippedNoRenderer.

async function testShellSuspectedRetrySkippedWhenNoRendererConfigured(baseUrl: string) {
  const source: IngestionSourceConfig = {
    key: "test-shell-no-renderer",
    name: "Shell Marker Source (no renderer configured)",
    url: `${baseUrl}/shell-marker-page`,
  };

  const specs: StubProposalSpec[] = [
    { fieldPath: "items[].name", candidateValue: HYDRATED_MARKER, needle: HYDRATED_MARKER },
  ];

  const result = await runTraversePipelineForSource(source, {
    provider: createStubProvider(specs, { model: "stub-shell-no-renderer" }),
    store: createInMemorySnapshotStore(),
    sink: async () => null,
    mode: "live-with-capture",
    log: () => {},
    // No renderer is configured. The exact-origin capability permits only
    // this process-local fixture's plain-fetch hop.
    fetchOptions: { testOnlyAllowedLoopbackOrigins: [baseUrl] } as never,
  });

  assert.equal(result.ok, true, `expected ok=true (first attempt succeeded), got fetchError=${result.fetchError} extractionError=${result.extractionError}`);
  assert.ok(result.shellEscalation, "the empty-#root shell must still be detected on the first attempt");
  assert.equal(result.shellEscalation!.shellDetected, true);
  assert.equal(result.shellEscalation!.renderRetried, false, "no renderer configured — the retry must never be issued");
  assert.equal(result.shellEscalation!.retrySkippedNoRenderer, true, "the skip decision must be recorded explicitly");
  assert.equal(result.shellEscalation!.renderRetryFailed, false, "a SKIPPED retry is not a FAILED retry — these are distinct");
  assert.equal(result.shellEscalation!.retryAttemptItemCount, undefined, "no retry ran, so no retry item count");
  assert.equal(result.itemCount, 0, "the unrendered first attempt cannot see the hydrated marker, so it groups zero items");
  assert.equal(result.rendered, undefined, "no render occurred");
  assert.equal(result.fetchError, null, "the OVERALL result is not a fetch failure — the first attempt itself succeeded (0 items is still ok)");

  console.log("✓ a shell-suspected source with no renderImpl configured skips the retry (never a doomed invalid-config attempt)");
}

// ─── Run ─────────────────────────────────────────────────────────────────

async function main() {
  const { baseUrl, server, renderRequestCounts } = await startFixtureServer();
  try {
    await testShellDetectedAutoRetryRecoversMarker(baseUrl);
    await testEmbeddedStateAvailableSkipsRender(baseUrl);
    await testRenderRetryFailureKeepsFirstAttempt(baseUrl);
    await testRenderTrueSourceNeverDoubleRetries(baseUrl, renderRequestCounts);
    await testShellSuspectedRetrySkippedWhenNoRendererConfigured(baseUrl);
  } finally {
    await closeRenderBrowser();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("\nshell-detect-retry verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
