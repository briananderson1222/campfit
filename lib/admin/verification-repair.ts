/**
 * verification-repair.ts — re-derive the cache of exactly the camps whose
 * cached `dataConfidence` says VERIFIED while their claims no longer derive
 * VERIFIED (for example a camp verified only because Mark Verified used to
 * attest an empty price list; see docs/verification-authority.md, "Empty
 * required lists").
 *
 * Only the camps `buildDowngradeImpactReport` lists are touched, never all
 * camps: a refresh stamps `lastVerifiedAt`, and re-stamping a camp that is
 * still VERIFIED would publicly re-date it. Each refresh is the standalone
 * one (`refreshCampVerificationCache`): one transaction, under the camp's
 * lock, which derives again before it writes.
 */
import type { Pool } from 'pg';

import type { DataConfidence } from '@/lib/types';

import { buildDowngradeImpactReport } from './claim-store-backfill';
import { refreshCampVerificationCache } from './verification-authority';

export interface DowngradeRepairResult {
  readonly applied: boolean;
  /** Camps cached VERIFIED that do not derive VERIFIED, as listed before any write. */
  readonly listed: readonly { readonly campId: string; readonly campName: string; readonly derived: DataConfidence }[];
  /** With `apply`: each listed camp's cache as the refresh wrote it. */
  readonly refreshed: readonly { readonly campId: string; readonly dataConfidence: DataConfidence }[];
}

export async function repairDowngradedCamps(pool: Pool, options: { readonly apply: boolean }): Promise<DowngradeRepairResult> {
  const report = await buildDowngradeImpactReport(pool);
  const listed = report.downgrades.map((d) => ({ campId: d.campId, campName: d.campName, derived: d.derivedDataConfidence }));
  if (!options.apply) return { applied: false, listed, refreshed: [] };
  const refreshed: { campId: string; dataConfidence: DataConfidence }[] = [];
  for (const { campId } of listed) {
    const result = await refreshCampVerificationCache(campId);
    refreshed.push({ campId, dataConfidence: result.dataConfidence });
  }
  return { applied: true, listed, refreshed };
}
