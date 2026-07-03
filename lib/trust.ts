/**
 * lib/trust.ts — single source of truth for the public verified/unverified
 * trust distinction (I21, issue #48).
 *
 * The public trust signal is `Camp.dataConfidence === 'VERIFIED'`. The admin
 * approve path sets that enum only when `isFullyVerified()` holds over every
 * `REQUIRED_FOR_VERIFIED` field (lib/admin/verification.ts). The read path
 * here never re-derives coverage — it trusts the persisted enum, so the badge
 * (TrustBadge), the default ranking (rankByTrust), and the admin coverage
 * metric (getVerifiedCoverageMetric) all agree on one definition of "verified".
 *
 * Two revertible display flags gate everything here (R5/AC5):
 *   NEXT_PUBLIC_TRUST_DISPLAY    — verified/unverified badges       (default on)
 *   NEXT_PUBLIC_VERIFIED_RANKING — verified-first default ranking   (default on)
 * Rollback = set the flag to "0"/"false"/"off" and redeploy; no data change.
 */
import type { Camp } from '@/lib/types';

/** A flag is ON unless explicitly disabled with "0" / "false" / "off" / "no". */
export function isFlagEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export function isTrustDisplayEnabled(): boolean {
  return isFlagEnabled(process.env.NEXT_PUBLIC_TRUST_DISPLAY);
}

export function isVerifiedRankingEnabled(): boolean {
  return isFlagEnabled(process.env.NEXT_PUBLIC_VERIFIED_RANKING);
}

/** True only for camps whose data has been fully attested (dataConfidence VERIFIED). */
export function isCampVerified(camp: Pick<Camp, 'dataConfidence'>): boolean {
  return camp.dataConfidence === 'VERIFIED';
}

export interface TrustStatus {
  verified: boolean;
  /** Short badge text. */
  label: string;
  /** Longer, always-honest caption / tooltip. */
  detail: string;
}

/**
 * The honest status for a camp. Verified camps show when they were confirmed
 * (if known); everything else is plainly labelled "Unverified" with a caption
 * that tells the reader to check the camp's own website — never a claim of
 * certainty we don't have.
 */
export function trustStatus(
  camp: Pick<Camp, 'dataConfidence' | 'lastVerifiedAt'>,
): TrustStatus {
  if (isCampVerified(camp)) {
    const since = camp.lastVerifiedAt
      ? new Date(camp.lastVerifiedAt).toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
        })
      : null;
    return {
      verified: true,
      label: since ? `Verified ${since}` : 'Verified',
      detail: since
        ? `CampFit confirmed every required detail (${since}).`
        : 'CampFit confirmed every required detail.',
    };
  }
  return {
    verified: false,
    label: 'Unverified',
    detail:
      'Details are unconfirmed — check the camp website before you rely on them.',
  };
}

/**
 * Stable verified-first ordering (R2/AC2). Preserves the caller's within-group
 * order (e.g. alphabetical), so verified camps float to the top without
 * otherwise reshuffling — and, critically, NEVER drops unverified camps, so a
 * near-0%-coverage catalog is reordered, not emptied.
 */
export function rankByTrust<T extends Pick<Camp, 'dataConfidence'>>(camps: T[]): T[] {
  return camps
    .map((camp, index) => ({ camp, index }))
    .sort((a, b) => {
      const av = isCampVerified(a.camp) ? 0 : 1;
      const bv = isCampVerified(b.camp) ? 0 : 1;
      if (av !== bv) return av - bv;
      return a.index - b.index; // explicit tiebreak → stable on every engine
    })
    .map((entry) => entry.camp);
}

/** `rankByTrust` gated by the ranking flag; identity (unchanged order) when off. */
export function applyDefaultRanking<T extends Pick<Camp, 'dataConfidence'>>(
  camps: T[],
): T[] {
  return isVerifiedRankingEnabled() ? rankByTrust(camps) : camps;
}
