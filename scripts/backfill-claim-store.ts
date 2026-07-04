#!/usr/bin/env tsx
/**
 * scripts/backfill-claim-store.ts — one-time, idempotent backfill of
 * `Camp.fieldSources` + `FieldAttestation` legacy data into migration 012's
 * `SurfaceClaimDefinition`/`SurfaceEvidence`/`SurfaceVerificationEvent`
 * tables (`lib/admin/claim-store.ts`, via `lib/admin/claim-store-backfill.ts`
 * — see that module's header comment for the full legacy -> ClaimStore
 * mapping, scope, and idempotency mechanism). Part of this slice's AC3
 * ("cutover-with-backfill": both legacy stores project into the ClaimStore;
 * legacy stays readable for rollback — see `.kontourai/flow-agents/
 * verification-authority/verification-authority--deliver-plan.md`, Wave 3
 * "Backfill script + module").
 *
 * ── Connection safety idiom (V6 fix, security review SF2) ──────────────────
 * This script's writes ARE additive-only (new Claim/Evidence/
 * VerificationEvent rows; never a DROP/TRUNCATE/DELETE), so — unlike
 * `scripts/test-db-reset.ts`, which is destructive and therefore reads
 * `TEST_DATABASE_URL` exclusively with no fallback — it resolves its
 * connection through the SAME single source of truth every other command in
 * this repo uses (`lib/db.ts`'s `getPool()` / `lib/db-config.ts`'s
 * `resolvePgConfig()`: `DATABASE_URL`/`POSTGRES_URL` or
 * `PGHOST`/`PGUSER`/`PGPASSWORD`). That flexibility was previously also a
 * hazard: this file loads `.env.prod` FIRST (below), so a bare
 * `npx tsx scripts/backfill-claim-store.ts` — with no flags, dry-run or
 * not — run on a machine with a local `.env.prod` present would silently
 * read (and, without `--dry-run`, write) the real production database.
 * `assertTestLikeDatabase` (below) refuses to run AT ALL, for both `--dry-run`
 * and a real run, unless the resolved connection looks like the throwaway
 * test database (loopback host + `sslmode=disable`, exactly what
 * `TEST_DATABASE_URL`/`tests/integration/global-setup.ts`'s env remap
 * produce) — matching `test-db-reset.ts`'s strict idiom of never trusting an
 * ambient/implicit connection target. Pointing this script at the real
 * Supabase instance for an eventual production cutover is a separate,
 * deliberate, human-run step (like migrations 001-011): pass
 * `--allow-production` explicitly to do so.
 *
 * ── Downgrade-impact report (V7 fix) ────────────────────────────────────────
 * `--report` (implied by `--dry-run`) prints `lib/admin/claim-store-
 * backfill.ts`'s `buildDowngradeImpactReport`: every currently-`VERIFIED`
 * Camp whose derived status (post-backfill Claim ledger) is NOT `VERIFIED` —
 * the "legacy-VERIFIED -> PLACEHOLDER downgrade" blast radius named in
 * `docs/verification-authority.md`'s Semantic finding, made a required
 * pre-deploy check instead of an advisory "consider auditing this" note.
 *
 * Usage:
 *   npx tsx scripts/backfill-claim-store.ts             # writes (refuses non-test-shaped targets)
 *   npx tsx scripts/backfill-claim-store.ts --dry-run    # reports counts + downgrade-impact only, no writes
 *   npx tsx scripts/backfill-claim-store.ts --report     # downgrade-impact report only (no backfill writes either way)
 *   npx tsx scripts/backfill-claim-store.ts --allow-production          # bypass the test-shaped connection guard (dry-run default-safe still applies)
 *   npx tsx scripts/backfill-claim-store.ts --allow-production --report # read-only downgrade-impact audit against a real target
 */
import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { getPool } from '@/lib/db';
import { resolvePgConfig } from '@/lib/db-config';
import { backfillClaimStore, buildDowngradeImpactReport } from '@/lib/admin/claim-store-backfill';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * V6 fix (MEDIUM, security review SF2): refuses to run — for `--dry-run` OR
 * a real (write) run alike — unless the resolved connection is
 * `TEST_DATABASE_URL`-shaped: a loopback host with `ssl === false`
 * (`lib/db-config.ts`'s `parseConnectionString` only ever sets this for a
 * connection string that explicitly requested `sslmode=disable` AND is a
 * loopback host — never a real remote host like the production Supabase
 * instance) AND a database name containing "test". This is exactly the
 * shape `TEST_DATABASE_URL` (e.g.
 * `postgresql://postgres:postgres@127.0.0.1:5433/campfit_test?sslmode=disable`)
 * and `tests/integration/global-setup.ts`'s `DATABASE_URL` env remap both
 * produce. `--allow-production` bypasses this deliberately, for the one,
 * human-run production cutover.
 */
function assertTestLikeDatabase(allowProduction: boolean): void {
  if (allowProduction) {
    console.warn(
      '[backfill-claim-store] --allow-production supplied: skipping the TEST_DATABASE_URL-shaped ' +
        'connection guard. This run will read (and, without --dry-run, write) whatever ' +
        'DATABASE_URL/POSTGRES_URL/PGHOST currently resolves to — confirm that is intentional.',
    );
    return;
  }

  const config = resolvePgConfig();
  const isLoopback = config != null && LOOPBACK_HOSTS.has(config.host.toLowerCase());
  const looksLikeTestDb = config != null && config.ssl === false && isLoopback && /test/i.test(config.database);

  if (!looksLikeTestDb) {
    throw new Error(
      'Refusing to run scripts/backfill-claim-store.ts: the resolved database connection ' +
        `(host: ${config?.host ?? '<none>'}, database: ${config?.database ?? '<none>'}) does not look like a ` +
        'throwaway TEST_DATABASE_URL-shaped target (expected a loopback host with sslmode=disable and ' +
        '"test" in the database name — exactly what TEST_DATABASE_URL/global-setup.ts\'s env remap produce). ' +
        'This guards against a bare `npx tsx scripts/backfill-claim-store.ts` picking up a local .env.prod ' +
        'and reading/writing the real production database by accident (security review SF2) — this check ' +
        'applies to --dry-run runs too, not just writes. Pass --allow-production to run against a ' +
        'non-test-shaped target deliberately.',
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allowProduction = args.includes('--allow-production');
  // --report is implied by --dry-run: an operator checking "what would this
  // write" should always also see "what would this cause to downgrade" in
  // the same pass (V7 fix) — see this file's header comment.
  const report = args.includes('--report') || dryRun;

  assertTestLikeDatabase(allowProduction);

  log(`Starting ClaimStore backfill${dryRun ? ' (DRY RUN — no writes)' : ''}...`);
  const pool = getPool();
  const summary = await backfillClaimStore(pool, { dryRun });

  log(`Camps scanned: ${summary.campsScanned}`);
  log(
    `fieldSources: ${summary.fieldSourcesProjected} projected, ${summary.fieldSourcesSkipped} skipped ` +
      `(not one of the 8 Verified Camp fields)`,
  );
  log(
    `FieldAttestation rows: ${summary.fieldAttestationRowsProjected} projected, ` +
      `${summary.fieldAttestationRowsSkipped} skipped (not CAMP entityType, or not a Verified Camp field)`,
  );
  log(`Evidence rows inserted: ${summary.evidenceInserted}`);
  log(`VerificationEvent rows inserted: ${summary.eventsInserted}`);
  log(dryRun ? 'Dry run complete — no rows were written.' : 'Backfill complete.');

  if (report) {
    log('Building downgrade-impact report (V7) — every currently-VERIFIED Camp whose derived status is not VERIFIED...');
    const impact = await buildDowngradeImpactReport(pool);
    log(`Downgrade-impact report: ${impact.campsEvaluated} currently-VERIFIED camp(s) evaluated, ${impact.downgrades.length} would downgrade.`);
    for (const downgrade of impact.downgrades) {
      log(`  - ${downgrade.campId} ("${downgrade.campName}"): ${downgrade.currentDataConfidence} -> ${downgrade.derivedDataConfidence}`);
    }
    if (impact.downgrades.length > 0 && !dryRun) {
      log(
        'NOTE: the counts above reflect the ClaimStore state AFTER this run\'s backfill writes ' +
          '(unless --dry-run was also passed) — re-run with --report (no --dry-run needed) any time to ' +
          're-check the current blast radius before deploying the verification-authority cutover.',
      );
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
