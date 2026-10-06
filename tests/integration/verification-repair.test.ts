/**
 * The post-deploy repair: re-derive the cache of exactly the camps cached
 * VERIFIED whose claims no longer derive VERIFIED, run as the operator runs
 * it (a child process), against the throwaway test database.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getPool as getProductionPool } from '@/lib/db';
import { bulkAttestCamp } from '@/lib/admin/bulk-attestation';
import { recordStewardEntry } from '@/lib/admin/steward-entry';
import { getTestDatabaseUrl } from '../../scripts/test-db-reset';
import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const OLD = '2020-01-01 00:00:00';

async function script(file: string, args: string[], databaseUrl = getTestDatabaseUrl()) {
  const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: databaseUrl };
  for (const key of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT', 'POSTGRES_URL']) delete env[key];
  try {
    const { stdout } = await run('npx', ['tsx', `scripts/${file}`, ...args], { cwd: ROOT, env: env as NodeJS.ProcessEnv, timeout: 120000 });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

async function insertCamp(name: string): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, city, "websiteUrl") VALUES ($1, $2, 'SUMMER_DAY', 'NATURE', 'd', 'Golden', 'https://x.example.test/') RETURNING id`,
    [`repair-${randomUUID()}`, name],
  );
  return rows[0]!.id;
}

async function cache(campId: string) {
  const { rows } = await getTestPool().query<{ dataConfidence: string; lastVerifiedAt: string | null }>(`SELECT "dataConfidence", "lastVerifiedAt"::text AS "lastVerifiedAt" FROM "Camp" WHERE id = $1`, [campId]);
  return { dataConfidence: rows[0]!.dataConfidence, lastVerifiedAt: rows[0]!.lastVerifiedAt };
}

beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

describe('scripts/repair-downgraded-camps.ts', () => {
  it('lists without writing by default, refreshes only the listed camps with --apply, and is a no-op when re-run', async () => {
    // Cached VERIFIED, but nothing derives it (an empty list and no sessions attested by nothing).
    const stale = await insertCamp('Stale camp');
    await getTestPool().query(`UPDATE "Camp" SET "dataConfidence" = 'VERIFIED', "lastVerifiedAt" = $2 WHERE id = $1`, [stale, OLD]);
    // Genuinely VERIFIED: lists with rows, sessions attested as none, Mark Verified.
    const genuine = await insertCamp('Genuine camp');
    await getTestPool().query(`INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge") VALUES (gen_random_uuid()::text, $1, 'Ages 6 - 10', 6, 10)`, [genuine]);
    await getTestPool().query(`INSERT INTO "CampPricing" (id, "campId", label, amount, unit) VALUES (gen_random_uuid()::text, $1, 'Tuition', 450, 'PER_WEEK')`, [genuine]);
    await recordStewardEntry(genuine, { kind: 'intentionally-empty', field: 'schedules', reason: 'No sessions.' }, 'steward@campfit.test');
    expect((await bulkAttestCamp(genuine, 'steward@campfit.test')).dataConfidence).toBe('VERIFIED');
    await getTestPool().query(`UPDATE "Camp" SET "lastVerifiedAt" = $2 WHERE id = $1`, [genuine, OLD]);

    const dry = await script('repair-downgraded-camps.ts', []);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('1 camp(s) cached VERIFIED that do not derive VERIFIED (dry run');
    expect(dry.out).toContain(stale);
    expect(dry.out).not.toContain(genuine);
    expect(await cache(stale)).toEqual({ dataConfidence: 'VERIFIED', lastVerifiedAt: OLD });
    expect(await cache(genuine)).toEqual({ dataConfidence: 'VERIFIED', lastVerifiedAt: OLD });

    const applied = await script('repair-downgraded-camps.ts', ['--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(`refreshed ${stale}: PLACEHOLDER`);
    expect((await cache(stale)).dataConfidence).toBe('PLACEHOLDER');
    // Never re-dated: a camp that is still VERIFIED is not touched.
    expect(await cache(genuine)).toEqual({ dataConfidence: 'VERIFIED', lastVerifiedAt: OLD });

    const staleAfter = await cache(stale);
    const again = await script('repair-downgraded-camps.ts', ['--apply']);
    expect(again.out).toContain('0 camp(s) cached VERIFIED');
    expect(await cache(stale)).toEqual(staleAfter);
    expect(await cache(genuine)).toEqual({ dataConfidence: 'VERIFIED', lastVerifiedAt: OLD });
  }, 600000);

  it('refuses a target that does not look like the throwaway test database', async () => {
    const refused = await script('repair-downgraded-camps.ts', ['--apply'], 'postgresql://user:pw@db.example.test:5432/campfit?sslmode=require');
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('Refusing to run scripts/repair-downgraded-camps.ts');
  }, 300000);
});

describe('scripts/backfill-claim-store.ts --report', () => {
  it('is a read: it writes no backfill rows', async () => {
    const campId = await insertCamp('Legacy camp');
    await getTestPool().query(`UPDATE "Camp" SET "fieldSources" = $2::jsonb WHERE id = $1`,
      [campId, JSON.stringify({ city: { excerpt: 'Golden', sourceUrl: 'https://x.example.test/', approvedAt: OLD } })]);
    const count = async () => (await getTestPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM "SurfaceEvidence"`)).rows[0]!.n;
    const before = await count();
    const report = await script('backfill-claim-store.ts', ['--report']);
    expect(report.code).toBe(0);
    expect(report.out).toContain('DRY RUN');
    expect(await count()).toBe(before);
  }, 300000);
});
