/**
 * scripts/discover.ts — provider discovery job (I22 / #52).
 *
 * Runs a discovery source through the metro filter + dedupe and lands new
 * provider candidates in the "ProviderCandidate" review queue. It never creates
 * a Provider — onboarding a candidate is a separate, human-triggered approval.
 *
 * Usage:
 *   npx tsx scripts/discover.ts                      # default source, write to queue
 *   npx tsx scripts/discover.ts --dry-run             # classify + report, no writes
 *   npx tsx scripts/discover.ts --source denver-rec-centers
 *   npx tsx scripts/discover.ts --community denver
 *
 * DB connection resolves via resolvePgConfig() (PGHOST/... or DATABASE_URL),
 * the same way the traverse scrape job does. `ensureProviderCandidateSchema`
 * creates the queue table on first run (idempotent) so the job works before the
 * additive migration 013 is applied.
 */
import { Pool } from "pg";

import { resolvePgConfig } from "@/lib/db-config";
import {
  DEFAULT_DISCOVERY_SOURCE_KEY,
  DISCOVERY_SOURCES,
  getDiscoverySource,
} from "@/lib/ingestion/discovery";
import { runDiscovery, type DiscoverySummary } from "@/lib/ingestion/discovery/runner";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run");
  const sourceKey = argv.includes("--source")
    ? argv[argv.indexOf("--source") + 1]
    : DEFAULT_DISCOVERY_SOURCE_KEY;
  return { dryRun, sourceKey };
}

function buildPool(): Pool {
  const config = resolvePgConfig();
  if (!config) {
    throw new Error(
      "Missing database env vars for discovery job: set PGHOST/PGUSER/PGPASSWORD or DATABASE_URL",
    );
  }
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === false ? false : { rejectUnauthorized: false },
    max: 3,
  });
}

function printSummary(summary: DiscoverySummary, dryRun: boolean): void {
  console.log(`\nSource:      ${summary.sourceLabel} (${summary.sourceKey})`);
  console.log(`Community:   ${summary.communitySlug}`);
  console.log(`Query:       ${summary.discoveryQuery}`);
  console.log(`Retrieved:   ${summary.retrievedAt.toISOString()}`);
  console.log(
    `\nDiscovered ${summary.discovered} | ` +
      `enqueued-new ${summary.enqueuedNew} | ` +
      `enqueued-near-dup ${summary.enqueuedNearDuplicate} | ` +
      `skipped-duplicate ${summary.skippedDuplicate} | ` +
      `excluded-out-of-metro ${summary.excludedOutOfMetro}` +
      `${dryRun ? "  (DRY RUN — nothing written)" : ""}`,
  );

  console.log("\nPer-candidate disposition:");
  for (const o of summary.outcomes) {
    const city = o.candidate.city ?? "(unknown city)";
    const detail = o.detail ? ` — ${o.detail}` : "";
    console.log(`  [${o.disposition}] ${o.candidate.name} · ${city}${detail}`);
  }
  console.log("");
}

async function main() {
  const { dryRun, sourceKey } = parseArgs(process.argv.slice(2));

  const source = getDiscoverySource(sourceKey);
  if (!source) {
    console.error(
      `Unknown discovery source "${sourceKey}". Available: ${DISCOVERY_SOURCES.map((s) => s.key).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`\nCampFit provider discovery${dryRun ? " (DRY RUN)" : ""}`);

  // Discovery reads the Provider table + existing queue to dedupe even in
  // dry-run, so a DB connection is always needed; dry-run only suppresses writes.
  const pool = buildPool();
  try {
    const summary = await runDiscovery(source, { dryRun, pool });
    printSummary(summary, dryRun);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
