/**
 * lib/admin/onboarding-validation.ts — shared URL/domain validation helpers
 * for provider/camp onboarding, extracted per campfit#90 Wave 1 to replace
 * two byte-identical private `parseDomain` copies (`provider-repository.ts`
 * and `app/api/admin/crawl/onboard-url/route.ts`) with one canonical
 * implementation. `lib/ingestion/discovery/dedupe.ts`'s `normalizeDomain`
 * documents itself as mirroring this function — do not add new
 * normalization rules (punycode, port stripping, etc.) here without
 * updating that mirror too.
 */

/**
 * `true` only for a value that parses via `new URL(value)` with protocol
 * `http:`/`https:`. `null`/`undefined`/empty string is treated as
 * "not provided" (valid) — callers that require the field must check for
 * presence separately.
 */
export function isValidHttpUrl(value: string | null | undefined): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extracts a normalized domain from a URL: hostname with a leading `www.`
 * stripped and lowercased. Returns `null` for a missing/unparseable URL.
 * The `.toLowerCase()` is a defensive no-op today (`URL.hostname` already
 * lowercases ASCII hosts per the WHATWG URL spec) that documents the
 * invariant other lanes (e.g. discovery dedupe) rely on.
 */
export function parseDomain(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
