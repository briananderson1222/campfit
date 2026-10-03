/**
 * recrawl-freshness.ts — the one place a crawl writes its own state onto a Camp.
 *
 * Three columns, none of them a verification:
 *  - `lastCrawlAttemptAt`: a crawl tried this camp, whatever happened. The
 *    scheduler orders by it, so a camp that keeps failing rotates to the back
 *    instead of being reselected forever.
 *  - `lastCrawledAt`: a crawl of this camp completed (it produced a proposal,
 *    found no changes, or found the page unchanged). Never set by a failure.
 *  - `lastExtractedContentDigest`: fingerprint of the page text a COMPLETE
 *    extraction read (content-fingerprint.ts); the next crawl skips the model
 *    call when it fetches the same text.
 *
 * Timestamp authority: a crawl proves what a page said, not that the camp's
 * claims are right. So this NEVER touches `Camp.lastVerifiedAt` or
 * `Camp.dataConfidence`. Those are owned solely by claim verification
 * (`refreshCampVerificationCache`; see docs/verification-authority.md).
 *
 * Each write is a parameterized single-camp `id = $n` UPDATE, so it cannot fan
 * out, and returns whether the row existed so a deleted camp is observable.
 */
import type { Pool } from 'pg';

export interface RecordRecrawlFreshnessInput {
  /** the exact camp whose page was found unchanged — the sole UPDATE target. */
  campId: string;
  /**
   * The instant to record on `lastCrawledAt`. Omit it (the crawl pipeline
   * does) to stamp the DATABASE clock, for the reason given on
   * {@link RecordCrawlAttemptInput.attemptedAt}. Pass a value only to pin the
   * time in a test.
   */
  checkedAt?: Date;
}

/**
 * Record crawl freshness (`lastCrawledAt`) for one camp. Writes NOTHING else.
 *
 * @returns `true` when exactly the target camp row was updated; `false` when no
 * row matched (missing/deleted camp), so the caller can surface the miss.
 */
export async function recordRecrawlFreshness(
  pool: Pool,
  input: RecordRecrawlFreshnessInput
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE "Camp" SET "lastCrawledAt" = COALESCE($1::timestamptz, now()) WHERE id = $2',
    [input.checkedAt ?? null, input.campId]
  );
  return (result.rowCount ?? 0) > 0;
}

export interface RecordCrawlAttemptInput {
  campId: string;
  /**
   * When the attempt finished. Omit it (the crawl pipeline does) to stamp the
   * DATABASE clock, `now()`. The skip rule compares these columns with
   * `CampChangeLog."changedAt"` and proposal `"reviewedAt"`, which the
   * database stamps; an application clock a few milliseconds off the
   * database's would make "changed since the last crawl" wrong either way.
   * Pass a value only to pin the time in a test.
   */
  attemptedAt?: Date;
  /** the crawl completed for this camp (any outcome that is not an error). */
  completed: boolean;
  /** fingerprint to remember, only when a COMPLETE extraction read that text. Omit to keep the stored one. */
  extractedContentDigest?: string;
}

/**
 * Record one camp's crawl attempt: always `lastCrawlAttemptAt`; `lastCrawledAt`
 * only when it completed; the content digest only when one is given.
 */
export async function recordCrawlAttempt(pool: Pool, input: RecordCrawlAttemptInput): Promise<boolean> {
  const result = await pool.query(
    `UPDATE "Camp"
        SET "lastCrawlAttemptAt" = COALESCE($1::timestamptz, now()),
            "lastCrawledAt" = CASE WHEN $2::boolean THEN COALESCE($1::timestamptz, now()) ELSE "lastCrawledAt" END,
            "lastExtractedContentDigest" = COALESCE($3, "lastExtractedContentDigest")
      WHERE id = $4`,
    [input.attemptedAt ?? null, input.completed, input.extractedContentDigest ?? null, input.campId]
  );
  return (result.rowCount ?? 0) > 0;
}
