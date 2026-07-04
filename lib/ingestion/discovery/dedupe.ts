/**
 * lib/ingestion/discovery/dedupe.ts — provider-candidate dedupe (R2/AC2).
 *
 * Match a raw candidate against (a) already-onboarded Provider rows and
 * (b) already-queued PENDING candidates, on normalized name + website domain:
 *
 *   - EXACT duplicate  → same normalized domain OR same normalized name as an
 *                        existing provider/candidate. Skipped: it never enters
 *                        the queue, so re-running discovery (or seeding a
 *                        candidate that matches an existing provider) produces
 *                        no duplicate queue entries.
 *   - NEAR duplicate    → a high name-similarity match (Dice coefficient) to an
 *                        existing PROVIDER that is not an exact match. Per the
 *                        coordination directive, near-matches are NOT
 *                        auto-merged and NOT skipped — the candidate is queued
 *                        with a "possible duplicate of X" pointer for a human to
 *                        adjudicate.
 *   - NEW              → no match; queued plainly.
 *
 * The Dice-coefficient bigram similarity mirrors lib/ingestion/llm-discovery.ts
 * (kept independent here to avoid coupling provider dedupe to that camp-name
 * pre-pass). Domain normalization mirrors lib/admin/provider-repository.ts's
 * parseDomain so a candidate and a Provider row key on the same host string.
 */

export const NEAR_DUPLICATE_THRESHOLD = 0.8;

/** A comparison key for an existing provider or already-queued candidate. */
export interface DedupeTarget {
  id: string;
  name: string;
  /** Registrable host, www-stripped, lowercased — or null when unknown. */
  domain: string | null;
}

export type DedupeVerdict =
  | { kind: "new" }
  | { kind: "exact-duplicate"; matched: DedupeTarget; reason: string }
  | { kind: "near-duplicate"; matched: DedupeTarget; score: number; reason: string };

/**
 * Lowercase, fold "&" to "and" (orgs write "Parks & Rec" and "Parks and Rec"
 * interchangeably), strip remaining punctuation, collapse whitespace — the name
 * match key used for both exact dedupe and Dice similarity.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** hostname without a leading www., lowercased — null when unparseable/empty. */
export function normalizeDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

// ── Dice-coefficient bigram similarity ──────────────────────────────────────

function bigrams(value: string): Set<string> {
  const s = normalizeName(value).replace(/\s+/g, " ");
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

export function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  ba.forEach((gram) => {
    if (bb.has(gram)) intersection++;
  });
  return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Classify a candidate against onboarded providers and already-queued
 * candidates. `queued` participates only in EXACT matching (two genuinely
 * distinct providers may have similar names — near-match is judged against
 * onboarded providers only, so it surfaces once rather than fanning out across
 * the queue).
 */
export function classifyCandidate(
  candidate: { name: string; domain: string | null },
  providers: DedupeTarget[],
  queued: DedupeTarget[],
): DedupeVerdict {
  const candName = normalizeName(candidate.name);
  const candDomain = candidate.domain;

  // (1) Exact duplicate against onboarded providers OR already-queued candidates.
  for (const target of [...providers, ...queued]) {
    if (candDomain && target.domain && candDomain === target.domain) {
      return {
        kind: "exact-duplicate",
        matched: target,
        reason: `same website domain (${candDomain})`,
      };
    }
    if (candName && normalizeName(target.name) === candName) {
      return {
        kind: "exact-duplicate",
        matched: target,
        reason: `same normalized name ("${candName}")`,
      };
    }
  }

  // (2) Near duplicate against onboarded providers only — surface, do not skip.
  let best: { target: DedupeTarget; score: number } | null = null;
  for (const target of providers) {
    const score = diceCoefficient(candidate.name, target.name);
    if (score >= NEAR_DUPLICATE_THRESHOLD && score < 1) {
      if (!best || score > best.score) best = { target, score };
    }
  }
  if (best) {
    return {
      kind: "near-duplicate",
      matched: best.target,
      score: best.score,
      reason: `name ${(best.score * 100).toFixed(0)}% similar to "${best.target.name}"`,
    };
  }

  return { kind: "new" };
}
