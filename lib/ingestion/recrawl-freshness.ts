/**
 * recrawl-freshness.ts — the narrow, parameterized repository seam that records
 * CRAWL freshness for a camp whose page a conditional-GET recrawl found
 * UNCHANGED (HTTP 304 / `Snapshot.notModified`) — campfit#77 AC1 (amended per
 * the issue #77 orchestrator ruling, 2026-07-10).
 *
 * Timestamp authority (the whole reason this is its own seam, not ad hoc SQL in
 * the recrawl adapter): a trustworthy 304 proves the PAGE BYTES are unchanged;
 * it does NOT re-verify the camp's claims. So this writes ONLY
 * `Camp.lastCrawledAt` — the crawl-scheduling freshness field the oldest-first
 * recrawl queue can key on — and DELIBERATELY NEVER touches `Camp.lastVerifiedAt`
 * or `Camp.dataConfidence`. Those remain owned solely by claim verification
 * (`refreshCampVerificationCache`, the sole writer of the Verified Camp Claim
 * Set derived cache — see docs/decisions/verified-camp-claim-set.md and
 * docs/verification-authority.md). Conflating a 304 with a verification event
 * would corrupt the verification-authority vocabulary (campfit#107, ADR-0001).
 *
 * Injectable `checkedAt` so tests assert the exact timestamp; a parameterized
 * single-camp `id = $2` UPDATE so it can never fan out to another camp; and a
 * boolean return so a missing/deleted target is observable to the caller rather
 * than silently swallowed.
 */
import type { Pool } from 'pg';

export interface RecordRecrawlFreshnessInput {
  /** the exact camp whose page was found unchanged — the sole UPDATE target. */
  campId: string;
  /** the freshness instant to record on `lastCrawledAt` (injected for deterministic tests). */
  checkedAt: Date;
}

/**
 * Record crawl freshness (`lastCrawledAt`) for one camp confirmed unchanged by a
 * conditional-GET recrawl. Writes NOTHING else — see this module's file doc for
 * why `lastVerifiedAt`/`dataConfidence` are deliberately untouched.
 *
 * @returns `true` when exactly the target camp row was updated; `false` when no
 * row matched (missing/deleted camp), so the caller can surface the miss.
 */
export async function recordRecrawlFreshness(
  pool: Pool,
  input: RecordRecrawlFreshnessInput
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE "Camp" SET "lastCrawledAt" = $1 WHERE id = $2',
    [input.checkedAt, input.campId]
  );
  return (result.rowCount ?? 0) > 0;
}
