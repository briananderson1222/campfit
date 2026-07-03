/**
 * render-fetch.ts — headless-Chromium fetch for JS-rendered sources
 * (issue #41).
 *
 * Some camp sources are JS-rendered SPAs whose plain fetch returns an empty
 * shell (the markup is populated client-side after load). A per-source
 * `render: true` (see `IngestionSourceConfig.render` in ./sources.ts) routes
 * that source's fetch through here instead of a plain HTTP GET.
 *
 * Since the full traverse cutover (PR #40), `lib/ingestion/traverse-pipeline.ts`
 * is the ONLY fetch path — there is no more CSS-selector `BaseScraper`. This
 * module therefore plugs into `@kontourai/traverse/fetch`'s injectable
 * `FetchLike` seam (`FetchSourceOptions.fetch`) via {@link createRenderFetchLike},
 * so a rendered source's bytes flow into the EXACT SAME downstream path
 * (snapshot capture -> content-prep -> schema-directed extraction) a
 * plain-fetched source's bytes do today — `fetchSource`/`fetchAndExtract`
 * never know the bytes came from a browser instead of a socket.
 *
 * `FetchLike` also serves `fetchSource`'s own robots.txt lookup (same
 * injected function, see @kontourai/traverse's fetch-source.ts) — rendering
 * a `.txt` file with a full browser would be wasteful and would corrupt
 * `parseRobots`'s plain-text parsing (Chromium wraps a text response in its
 * own HTML viewer chrome). {@link createRenderFetchLike} special-cases
 * a trailing `robots.txt` path to a plain `fetch()`, mirroring the pattern this
 * repo's own test fixtures already use (see `makeFixtureFetch` in
 * scripts/test-traverse-replay.ts) — only the configured source's actual
 * page is ever rendered.
 *
 * Browser lifecycle: a single Chromium instance is lazily launched on first
 * use and reused for every rendered source in the process (a "sweep" is one
 * `scripts/scrape.ts` invocation) — launching a browser per source would be
 * needlessly slow for a sweep with more than one rendered source. Callers
 * that own a sweep's lifetime (scripts/scrape.ts) call `closeRenderBrowser()`
 * once after the sweep finishes.
 *
 * Isolation: `renderPage()` throws (never swallows) on failure — including a
 * hard per-source timeout. `createRenderFetchLike()`'s FetchLike propagates
 * that throw to `fetchSource`'s own try/catch, which turns it into a typed,
 * non-throwing `FetchError` on the `FetchResult` — exactly how a plain
 * network/timeout failure is surfaced today — so `traverse-pipeline.ts`'s
 * existing per-source isolation (never throws; one source's failure never
 * stops the next) covers a render failure with no special-casing.
 */

import { chromium, errors as playwrightErrors, type Browser } from "@playwright/test";
import type { FetchLike, FetchLikeResponse } from "@kontourai/traverse/fetch";

/** Sane default hard timeout for a single rendered source (~30s). */
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

const RENDER_USER_AGENT =
  "Mozilla/5.0 (compatible; CampFitBot/1.0; +https://campfit.app/bot)";

export interface RenderResult {
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
): Promise<RenderResult> {
  const start = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage({ userAgent: RENDER_USER_AGENT });

  try {
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

export interface CreateRenderFetchLikeOptions {
  /** Hard per-attempt render timeout — see `renderPage()`. Defaults to DEFAULT_RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Invoked once per successful render with its telemetry, so a caller
   * (traverse-pipeline.ts) can surface render duration / fallback use on the
   * source's result without threading a return value through the FetchLike
   * contract itself (`FetchLike` must return a `FetchLikeResponse`, not a
   * render-specific shape).
   */
  onRendered?: (info: RenderResult) => void;
}

/**
 * Builds a `FetchLike` (the injectable fetch seam `@kontourai/traverse/fetch`
 * accepts as `FetchSourceOptions.fetch`) that renders every request via
 * headless Chromium — EXCEPT `/robots.txt` lookups, which fall through to a
 * plain `fetch()` (see the file doc for why). Pass this as
 * `fetchOptions.fetch` for a source with `render: true`.
 */
export function createRenderFetchLike(opts: CreateRenderFetchLikeOptions = {}): FetchLike {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;

  return async (url, init): Promise<FetchLikeResponse> => {
    if (url.endsWith("/robots.txt")) {
      return fetch(url, {
        method: init.method,
        headers: init.headers,
        redirect: init.redirect,
        signal: init.signal,
      });
    }

    const result = await renderPage(url, timeoutMs);
    opts.onRendered?.(result);

    return {
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null),
      },
      text: async () => result.html,
    };
  };
}
