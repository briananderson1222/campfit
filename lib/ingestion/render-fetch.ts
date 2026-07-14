/**
 * render-fetch.ts — headless-Chromium renderer for JS-rendered sources
 * (issue #41; migrated to traverse 0.13.0's native rendered-fetch seam,
 * campfit#53 spa-ingestion).
 *
 * Some camp sources are JS-rendered SPAs whose plain fetch returns an empty
 * shell (the markup is populated client-side after load). A per-source
 * `render: true` (see `IngestionSourceConfig.render` in ./sources.ts) opts a
 * source into rendering — but rendering itself only actually happens when
 * the CALLER also configures `FetchSourceOptions.renderImpl` with the
 * function this module builds ({@link createCampfitRenderImpl}).
 *
 * Migration note (campfit#53): before traverse 0.13.0, this module built a
 * `FetchLike` (`createRenderFetchLike`, now removed) that FAKED a `Response`
 * from Playwright's rendered HTML and swapped it in for
 * `FetchSourceOptions.fetch` — that trick fetched real content, but the
 * resulting `Snapshot` never carried `rendered: true` (it flowed through the
 * generic wire-fetch path), which is dishonest about provenance (issue #53's
 * R3). traverse 0.13.0 (kontourai/traverse#41) added a REAL two-key seam:
 * `SourceConfig.render?: boolean` (the source opts in) AND
 * `FetchSourceOptions.renderImpl?: RenderImpl` (the caller configures a
 * renderer) — `fetchSource` only renders when BOTH are set, and a
 * successful render becomes a normal `Snapshot` with `rendered: true`
 * honestly set (see `docs/decisions/rendered-fetch.md` in
 * @kontourai/traverse's own repo). This module now builds a `RenderImpl`
 * (`createCampfitRenderImpl`), not a `FetchLike` — `renderPage()`'s browser
 * lifecycle, networkidle->domcontentloaded fallback, and hard-timeout
 * discipline are unchanged; only the adapter shape changed.
 *
 * Robots handling also changed as a side effect: traverse 0.13.0 checks
 * robots.txt EXACTLY ONCE, against the requested URL, before `renderImpl` is
 * ever invoked (decision 3, rendered-fetch.md) — using its own existing
 * plain-fetch robots lookup, never the injected `renderImpl`. The old
 * `/robots.txt` plain-fetch special-case this module used to need (so a
 * rendered `FetchLike` didn't try to render a `.txt` file with a full
 * browser) is therefore gone: `renderImpl` is now only ever called for the
 * actual target page.
 *
 * Browser lifecycle: production hostname renders use a dedicated Chromium
 * process because host-resolver rules are process-scoped; sharing that process
 * across unrelated hostnames would destroy the pinning boundary. IP literals
 * and explicit loopback fixtures retain the lazily launched shared browser.
 * Callers that own a sweep's lifetime (scripts/scrape.ts) still call
 * `closeRenderBrowser()` once to release that shared browser if it was used.
 *
 * Isolation: `renderPage()` throws (never swallows) on failure — including a
 * hard per-source timeout. `createCampfitRenderImpl()`'s `RenderImpl`
 * propagates that throw; traverse maps a thrown `renderImpl` to the existing
 * `adapter-error` `FetchErrorKind` on the (non-throwing) `FetchResult`
 * (decision 8, rendered-fetch.md) — exactly how a plain network/timeout
 * failure is surfaced today — so `traverse-pipeline.ts`'s existing
 * per-source isolation (never throws; one source's failure never stops the
 * next) covers a render failure with no special-casing.
 */

import { chromium, errors as playwrightErrors, type Browser, type Page } from "@playwright/test";
import type { RenderImpl, RenderResult } from "@kontourai/traverse/fetch";
import { isIP } from "node:net";
import {
  EgressUrlPolicyError,
  evaluateEgressUrl,
  type EgressAddress,
  type EgressResolver,
} from "@/lib/security/egress-url-policy";

/** Sane default hard timeout for a single rendered source (~30s). */
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

const RENDER_USER_AGENT =
  "Mozilla/5.0 (compatible; CampFitBot/1.0; +https://campfit.app/bot)";

/**
 * Render telemetry for ONE `renderPage()` call — deliberately NOT named
 * `RenderResult` (that name is traverse's own exported type,
 * `@kontourai/traverse/fetch`'s `RenderImpl` return shape) to avoid shadowing
 * it in this file's imports.
 */
export interface CampfitRenderTelemetry {
  /** Fully-rendered page HTML — the same shape a plain fetch's res.text() returns. */
  html: string;
  /** Wall-clock time (ms) the render took, start to finish. */
  durationMs: number;
  /**
   * True when the initial `networkidle` wait timed out and this result came
   * from the `domcontentloaded` fallback attempt instead — surfaced so the
   * ingestion summary can flag sources where content may be incomplete.
   */
  usedNetworkidleFallback: boolean;
}

// Module-level singleton for IP-literal and explicit loopback-fixture renders.
// Hostname renders cannot share it because their DNS pins are process-scoped.
let browserPromise: Promise<Browser> | null = null;

export class BrowserHostnameEgressUnavailableError extends Error {
  readonly name = "BrowserHostnameEgressUnavailableError";
  constructor() { super("Browser hostname egress unavailable: no pinned Chromium transport"); }
}
export function browserEgressRouteDecision(rawUrl: string): "pin-and-evaluate" | "evaluate-ip" {
  return isIP(new URL(rawUrl).hostname.replace(/^\[|\]$/g, ""))
    ? "evaluate-ip"
    : "pin-and-evaluate";
}
export function assertBrowserHostnameActivation(): void {
  // Readiness is derived from the exact routing policy, not a parallel flag.
  if (browserEgressRouteDecision("https://activation-probe.invalid/") !== "pin-and-evaluate") {
    throw new BrowserHostnameEgressUnavailableError();
  }
}

export interface PinnedBrowserNavigation {
  url: URL;
  hostname: string;
  address: EgressAddress;
  /** Chromium process argument; absent for an IP-literal URL. */
  hostResolverRule?: string;
}

/**
 * Resolve once through the shared SSRF policy and freeze the first address
 * only after the policy has classified every DNS answer as public. Chromium
 * then receives an exact-host MAP rule, so it connects to this address while
 * the original URL continues to supply the HTTP Host header and TLS SNI.
 *
 * The narrow DNS hostname grammar is also a command-argument boundary: commas
 * and whitespace could otherwise inject additional host-resolver rules.
 */
export async function preparePinnedBrowserNavigation(
  rawUrl: string,
  resolver?: EgressResolver,
): Promise<PinnedBrowserNavigation> {
  const evaluated = await evaluateEgressUrl(rawUrl, "fixedHarvester", { resolver });
  const hostname = evaluated.url.hostname.replace(/^\[|\]$/g, "");
  const address = evaluated.addresses[0];
  if (isIP(hostname)) return { url: evaluated.url, hostname, address };
  if (
    hostname.length > 253
    || !hostname.split(".").every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ))
  ) {
    throw new EgressUrlPolicyError("INVALID_HOST", "fixedHarvester", hostname);
  }
  const replacement = address.family === 6 ? `[${address.address}]` : address.address;
  return {
    url: evaluated.url,
    hostname,
    address,
    hostResolverRule: `MAP ${hostname} ${replacement}`,
  };
}

function normalizeTestLoopbackOrigins(origins: readonly string[]): ReadonlySet<string> {
  return new Set(origins.map((rawOrigin) => {
    const url = new URL(rawOrigin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.origin !== rawOrigin
      || url.protocol !== "http:"
      || url.port === ""
      || (hostname !== "127.0.0.1" && hostname !== "::1")
    ) {
      throw new TypeError("testOnlyAllowedLoopbackOrigins entries must be exact loopback URL origins");
    }
    return url.origin;
  }));
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  return browserPromise;
}

/**
 * Closes the shared render browser, if one was launched. Idempotent and
 * safe to call even if `renderPage()` was never invoked (e.g. a sweep with
 * no `render: true` sources). Callers that own a sweep's lifetime should
 * call this once after the sweep completes so the process can exit cleanly.
 */
export async function closeRenderBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof playwrightErrors.TimeoutError;
}

/**
 * Install before navigation. A production hostname render is bound to one
 * policy-approved address by its Chromium process's host-resolver rule. This
 * route permits only that hostname (re-evaluated against the already-pinned
 * address, never DNS) plus independently evaluated public IP literals.
 *
 * Cross-host redirects are deliberately blocked: Chromium resolver rules are
 * process-static, so following one would either use untrusted browser DNS or
 * require a second process/navigation with subtly different redirect
 * semantics. Cross-host subresources are blocked for the same reason. Same-
 * host redirects and subresources remain pinned, and HTTPS-to-HTTP redirects
 * are rejected before the request continues.
 */
export async function installGuardedPageNetwork(
  page: Page,
  resolver?: EgressResolver,
  testOnlyAllowedLoopbackOrigins: readonly string[] = [],
  pinnedNavigation?: PinnedBrowserNavigation,
): Promise<void> {
  const allowedLoopbackOrigins = normalizeTestLoopbackOrigins(testOnlyAllowedLoopbackOrigins);
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (allowedLoopbackOrigins.has(requestUrl.origin)) {
      await route.continue();
      return;
    }
    const requestHostname = requestUrl.hostname.replace(/^\[|\]$/g, "");
    const redirectedFrom = route.request().redirectedFrom();
    if (
      redirectedFrom
      && new URL(redirectedFrom.url()).protocol === "https:"
      && requestUrl.protocol === "http:"
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    try {
      if (pinnedNavigation) {
        if (requestHostname !== pinnedNavigation.hostname) {
          await route.abort("blockedbyclient");
          return;
        }
        // Supplying the frozen answer avoids every subsequent DNS lookup,
        // including requests produced by same-host redirects and SPA fetches.
        await evaluateEgressUrl(requestUrl, "browserSubresource", {
          resolver: async () => [pinnedNavigation.address],
        });
      } else if (browserEgressRouteDecision(requestUrl.href) === "evaluate-ip") {
        await evaluateEgressUrl(requestUrl, "browserSubresource", { resolver });
      } else {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

/**
 * Fetches `url`'s fully-rendered HTML via headless Chromium.
 *
 * Waits for `networkidle` (the safest signal that client-side data-fetching
 * has settled); if THAT specific wait times out, retries the SAME
 * navigation once with `domcontentloaded` (fires as soon as the initial DOM
 * is parsed, regardless of any still-open long-poll/websocket connection) so
 * a page that never goes fully idle doesn't fail outright. The fallback is
 * recorded on the result (`usedNetworkidleFallback`) so callers can surface
 * it as a warning.
 *
 * `timeoutMs` is the HARD per-attempt budget (each of up to two attempts —
 * the initial `networkidle` wait and, only if that times out, the
 * `domcontentloaded` retry — gets its own fresh `timeoutMs`), so total wall
 * time for one source is bounded by ~2×`timeoutMs` in the worst case: a
 * hung page can never stall the sweep indefinitely. Throws on any
 * unrecoverable failure (including both attempts timing out).
 */
export async function renderPage(
  url: string,
  timeoutMs: number = DEFAULT_RENDER_TIMEOUT_MS,
  testOnlyAllowedLoopbackOrigins: readonly string[] = [],
  deps: {
    resolver?: EgressResolver;
    /** Unit-test seam. Production always uses Playwright's Chromium launcher. */
    testOnlyBrowserLauncher?: typeof chromium.launch;
  } = {},
): Promise<CampfitRenderTelemetry> {
  const start = Date.now();
  const isLoopbackFixture = testOnlyAllowedLoopbackOrigins.length > 0;
  const pinnedNavigation = isLoopbackFixture
    ? undefined
    : await preparePinnedBrowserNavigation(url, deps.resolver);
  const ownsBrowser = pinnedNavigation?.hostResolverRule !== undefined;
  const browser = ownsBrowser
    ? await (deps.testOnlyBrowserLauncher ?? chromium.launch)({
        headless: true,
        args: [
          `--host-resolver-rules=${pinnedNavigation.hostResolverRule}`,
          // A configured system proxy could resolve the original hostname
          // itself and bypass Chromium's local DNS pin.
          "--no-proxy-server",
        ],
      })
    : await getBrowser();
  let page: Page | undefined;

  try {
    page = await browser.newPage({ userAgent: RENDER_USER_AGENT, serviceWorkers: "block" });
    await installGuardedPageNetwork(
      page,
      deps.resolver,
      testOnlyAllowedLoopbackOrigins,
      ownsBrowser ? pinnedNavigation : undefined,
    );
    let usedNetworkidleFallback = false;
    const navigationUrl = pinnedNavigation?.url.href ?? url;
    try {
      await page.goto(navigationUrl, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      usedNetworkidleFallback = true;
      console.warn(
        `[render-fetch] networkidle wait timed out for ${url} after ${timeoutMs}ms; retrying with domcontentloaded`
      );
      await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    }

    const html = await page.content();
    return { html, durationMs: Date.now() - start, usedNetworkidleFallback };
  } finally {
    await page?.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

export interface CreateCampfitRenderImplOptions {
  /** Hard per-attempt render timeout — see `renderPage()`. Defaults to DEFAULT_RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Exact loopback origins for local browser fixtures only. Production must leave this empty. */
  testOnlyAllowedLoopbackOrigins?: readonly string[];
  /** Deterministic policy seam for security tests. Production uses system DNS. */
  resolver?: EgressResolver;
  /** Unit-test seam. Production always uses Playwright's Chromium launcher. */
  testOnlyBrowserLauncher?: typeof chromium.launch;
}

/**
 * Builds a `RenderImpl` (`@kontourai/traverse/fetch`'s native rendered-fetch
 * seam — see this file's doc) that renders the requested URL via headless
 * Chromium. Pass this as `fetchOptions.renderImpl` for any source that may
 * set `SourceConfig.render: true` — traverse only invokes it when BOTH keys
 * are set (the two-key opt-in gate, rendered-fetch.md decision 1); a
 * `render: true` source with no `renderImpl` configured never reaches this
 * function at all (traverse surfaces a typed `invalid-config` `FetchError`
 * instead).
 *
 * `timeoutMs`: traverse passes this call's own `SourceConfig.timeoutMs`
 * (traverse-pipeline.ts sets it to `src.renderTimeoutMs` for a render
 * attempt) as a DOCUMENTED HINT — traverse does NOT wrap this call in its
 * own timeout race (unlike the old `FetchLike` seam this migrated off of;
 * see docs/decisions/rendered-fetch.md decision 2 in @kontourai/traverse's
 * own repo) — so THIS function is solely responsible for enforcing it,
 * which it does by forwarding it straight to `renderPage()`'s own hard,
 * two-attempt timeout budget. Falls back to this function's own
 * construction-time `opts.timeoutMs`/`DEFAULT_RENDER_TIMEOUT_MS` only in the
 * defensive case traverse ever calls this without a resolved `timeoutMs`
 * (it always resolves one today, from its own default or the caller's
 * `SourceConfig.timeoutMs`).
 *
 * Ignores `opts.userAgent`: `renderPage()`'s own `RENDER_USER_AGENT`
 * constant already owns campfit's honest, contactable bot identity (AC4),
 * fixed regardless of what a caller's `SourceConfig.userAgent` happens to be
 * for the (irrelevant, since headers/UA are inert on a rendered fetch per
 * decision 7) wire-fetch path.
 *
 * Warnings: when `renderPage()` had to fall back from `networkidle` to
 * `domcontentloaded` (`CampfitRenderTelemetry.usedNetworkidleFallback`), the
 * returned `RenderResult.warnings` carries a
 * `"render: networkidle fallback used after networkidle timeout (<ms>)"`
 * entry — traverse merges `RenderResult.warnings` into `FetchResult.warnings`
 * (see `@kontourai/traverse/fetch`'s `RenderResult` doc), so this is how the
 * fallback signal reaches `TraversePipelineSourceResult.warnings` (see
 * traverse-pipeline.ts). Absent (not an empty array) on a render that never
 * needed the fallback.
 */
export function createCampfitRenderImpl(opts: CreateCampfitRenderImplOptions = {}): RenderImpl {
  const testOnlyAllowedLoopbackOrigins = opts.testOnlyAllowedLoopbackOrigins ?? [];
  if (testOnlyAllowedLoopbackOrigins.length === 0) assertBrowserHostnameActivation();
  normalizeTestLoopbackOrigins(testOnlyAllowedLoopbackOrigins);
  const fallbackTimeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;

  return async (url, renderOpts): Promise<RenderResult> => {
    const timeoutMs = renderOpts?.timeoutMs ?? fallbackTimeoutMs;
    const result = await renderPage(url, timeoutMs, testOnlyAllowedLoopbackOrigins, {
      resolver: opts.resolver,
      testOnlyBrowserLauncher: opts.testOnlyBrowserLauncher,
    });

    const warnings = result.usedNetworkidleFallback
      ? [`render: networkidle fallback used after networkidle timeout (${timeoutMs}ms)`]
      : undefined;

    return { html: result.html, warnings };
  };
}

/**
 * Construct a render impl IF safe browser hostname egress is available in this
 * execution context, else return `undefined` so callers can degrade to
 * plain-fetch-only instead of crashing.
 *
 * Hostname egress is available through the pinned Chromium transport. Only a
 * genuine activation failure is swallowed; policy and construction errors
 * still surface normally.
 */
export function tryCreateCampfitRenderImpl(
  opts: CreateCampfitRenderImplOptions = {},
): RenderImpl | undefined {
  try {
    return createCampfitRenderImpl(opts);
  } catch (err) {
    if (err instanceof BrowserHostnameEgressUnavailableError) return undefined;
    throw err;
  }
}
