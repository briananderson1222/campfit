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
 * Browser lifecycle: a single Chromium instance is lazily launched on first
 * use and reused for every rendered source in the process (a "sweep" is one
 * `scripts/scrape.ts` invocation) — launching a browser per source would be
 * needlessly slow for a sweep with more than one rendered source. Callers
 * that own a sweep's lifetime (scripts/scrape.ts) call `closeRenderBrowser()`
 * once after the sweep finishes.
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
import { evaluateEgressUrl, type EgressResolver } from "@/lib/security/egress-url-policy";

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

// Module-level singleton: launched lazily on first `renderPage()` call, and
// reused by every subsequent call in this process — see the file doc above.
let browserPromise: Promise<Browser> | null = null;

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
 * Install before navigation. Chromium offers no supported way to connect to a
 * vetted IP while preserving hostname TLS/SNI, so hostname requests fail
 * closed. Public IP literals can be proven free of DNS rebinding and every
 * redirect/subresource request is re-evaluated by this route.
 */
export async function installGuardedPageNetwork(
  page: Page,
  resolver?: EgressResolver,
): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!isIP(requestUrl.hostname.replace(/^\[|\]$/g, ""))) {
      await route.abort("blockedbyclient");
      return;
    }
    try {
      await evaluateEgressUrl(requestUrl, "browserSubresource", { resolver });
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
  timeoutMs: number = DEFAULT_RENDER_TIMEOUT_MS
): Promise<CampfitRenderTelemetry> {
  const start = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage({ userAgent: RENDER_USER_AGENT, serviceWorkers: "block" });

  try {
    await installGuardedPageNetwork(page);
    let usedNetworkidleFallback = false;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch (err) {
      if (!isTimeoutError(err)) throw err;
      usedNetworkidleFallback = true;
      console.warn(
        `[render-fetch] networkidle wait timed out for ${url} after ${timeoutMs}ms; retrying with domcontentloaded`
      );
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    }

    const html = await page.content();
    return { html, durationMs: Date.now() - start, usedNetworkidleFallback };
  } finally {
    await page.close().catch(() => {});
  }
}

export interface CreateCampfitRenderImplOptions {
  /** Hard per-attempt render timeout — see `renderPage()`. Defaults to DEFAULT_RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
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
  const fallbackTimeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;

  return async (url, renderOpts): Promise<RenderResult> => {
    const timeoutMs = renderOpts?.timeoutMs ?? fallbackTimeoutMs;
    const result = await renderPage(url, timeoutMs);

    const warnings = result.usedNetworkidleFallback
      ? [`render: networkidle fallback used after networkidle timeout (${timeoutMs}ms)`]
      : undefined;

    return { html: result.html, warnings };
  };
}
