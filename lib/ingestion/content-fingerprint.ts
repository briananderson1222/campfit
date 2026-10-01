/**
 * content-fingerprint.ts — "is this the page the last extraction already read?"
 *
 * A snapshot's body hash cannot answer that. The raw HTML of an unchanged page
 * differs on every fetch: analytics scripts embed timings, a CDN embeds a
 * per-request challenge token, a server-rendered framework embeds a fresh
 * descriptor. Validators built from those bytes (a weak ETag that is the body
 * hash, a Last-Modified that is "now") therefore never produce a 304 either.
 *
 * The extraction never reads those bytes. It reads the prepared text (scripts
 * and page chrome removed), and that text is stable across fetches of an
 * unchanged page. The fingerprint is the SHA-256 of that prepared text together
 * with the extraction request (schema, hints and provider identity), so a
 * changed schema, hint or model re-extracts an unchanged page once.
 *
 * One token in the prepared text does change per request and is removed before
 * hashing: Cloudflare's email obfuscation rewrites every `mailto:` link to
 * `/cdn-cgi/l/email-protection#<hex>`, with a random key each time. The hex is
 * the same address under a different key, so it carries no content change.
 * Nothing else is normalized: any other difference is a changed page.
 */
import { createHash } from "node:crypto";
import { prepareAndChunk, type ContentType, type TargetFieldSchema } from "@kontourai/traverse";

const CLOUDFLARE_EMAIL_TOKEN = /\/cdn-cgi\/l\/email-protection#[0-9a-f]+/gi;

/** Fingerprint format version. Bump it when the hashed shape changes, so old fingerprints stop matching. */
const FINGERPRINT_VERSION = 1;

export function normalizePreparedTextForFingerprint(preparedText: string): string {
  return preparedText.replace(CLOUDFLARE_EMAIL_TOKEN, "/cdn-cgi/l/email-protection#");
}

export interface ContentFingerprintRequest {
  readonly targetSchema: readonly TargetFieldSchema[];
  readonly fieldHints?: Readonly<Record<string, string>>;
  /**
   * Identity of the extraction provider (its `name`, which carries the runtime
   * profile and model). A different model can read the same text differently,
   * so changing it re-extracts an unchanged page once.
   */
  readonly provider?: string;
}

/** Fingerprint of prepared text for one extraction request. `sha256:<hex>`. */
export function fingerprintPreparedText(preparedText: string, request: ContentFingerprintRequest): string {
  const hints = Object.entries(request.fieldHints ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ v: FINGERPRINT_VERSION, schema: request.targetSchema, hints, provider: request.provider ?? null }));
  hash.update("\0");
  hash.update(normalizePreparedTextForFingerprint(preparedText), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Fingerprint a snapshot body the way `extract()` would prepare it. Returns
 * `undefined` when the content cannot be prepared as text (a binary type): the
 * caller then extracts as before, with no skip.
 */
export function fingerprintSnapshotContent(
  content: string | Uint8Array,
  contentType: ContentType,
  request: ContentFingerprintRequest,
): string | undefined {
  const prepared = prepareAndChunk(content, contentType);
  if (prepared.error !== undefined) return undefined;
  return fingerprintPreparedText(prepared.fullText, request);
}
