#!/usr/bin/env tsx
/**
 * scripts/repair-downgraded-camps.ts — after deploying the "empty required
 * list is a gap" change, re-derive the cache of exactly the camps cached
 * VERIFIED whose claims no longer derive VERIFIED (lib/admin/verification-repair.ts).
 *
 * Dry run by default: lists the camps and writes nothing. `--apply` refreshes
 * those camps only (never all camps: a refresh re-stamps `lastVerifiedAt`).
 * Running it again after `--apply` lists nothing and writes nothing.
 *
 * Usage:
 *   npx tsx scripts/repair-downgraded-camps.ts                            # list only
 *   npx tsx scripts/repair-downgraded-camps.ts --apply                    # refresh the listed camps
 *   npx tsx scripts/repair-downgraded-camps.ts --allow-production [--apply]   # deliberately against a non-test target
 */
import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { getPool } from '@/lib/db';
import { repairDowngradedCamps } from '@/lib/admin/verification-repair';
import { assertTestLikeDatabase } from './test-like-database-guard';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  assertTestLikeDatabase('scripts/repair-downgraded-camps.ts', args.includes('--allow-production'));
  const result = await repairDowngradedCamps(getPool(), { apply });
  console.log(`${result.listed.length} camp(s) cached VERIFIED that do not derive VERIFIED${apply ? '' : ' (dry run: nothing written; pass --apply to refresh them)'}:`);
  for (const camp of result.listed) console.log(`  - ${camp.campId} ("${camp.campName}"): derives ${camp.derived}`);
  for (const camp of result.refreshed) console.log(`  refreshed ${camp.campId}: ${camp.dataConfidence}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
