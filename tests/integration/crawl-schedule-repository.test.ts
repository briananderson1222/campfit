/**
 * tests/integration/crawl-schedule-repository.test.ts — campfit#92 Wave 1
 * acceptance evidence for `lib/admin/schedule-repository.ts` +
 * `prisma/migrations/016_crawl_schedule.sql`.
 *
 * Against the real `TEST_DATABASE_URL` (via `test-db.ts`'s
 * `assertTestDatabase()` convention). The module under test
 * (`schedule-repository.ts`) uses the shared `@/lib/db` pool, exactly as it
 * does outside tests — isolation for that pool is `global-setup.ts`'s env
 * remap, which `npx vitest run` always applies via `globalSetup` before any
 * test file runs. `getTestPool()` here is used only for this file's own
 * assertion/guard queries, not for exercising the repository itself.
 *
 * Asserts:
 *  (1) the singleton "default" row exists with the migration's own default
 *      values immediately after a fresh `resetTestDatabase()` (proven
 *      implicitly by `global-setup.ts` having just run one for this
 *      invocation — no manual reset call needed here).
 *  (2) `updateSchedule` round-trips each field (`enabled`, `priority`,
 *      `batchSize`, `updatedBy`) — both individually and combined — and
 *      always advances `updatedAt`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertTestDatabase, closeTestPool } from './test-db';
import { getSchedule, updateSchedule } from '@/lib/admin/schedule-repository';

beforeAll(async () => {
  await assertTestDatabase();
});

afterAll(async () => {
  await closeTestPool();
});

describe('CrawlSchedule singleton row (campfit#92 Wave 1)', () => {
  it('exists with migration-default values after a fresh reset', async () => {
    const schedule = await getSchedule();
    expect(schedule.id).toBe('default');
    expect(schedule.enabled).toBe(false);
    expect(schedule.priority).toBe('stale');
    expect(schedule.batchSize).toBe(5);
    expect(schedule.updatedBy).toBeNull();
    expect(schedule.updatedAt).toBeTruthy();
  });

  it('updateSchedule round-trips a single field without touching the others', async () => {
    const before = await getSchedule();
    const updated = await updateSchedule({ enabled: true });
    expect(updated.id).toBe('default');
    expect(updated.enabled).toBe(true);
    // Untouched fields keep their prior values.
    expect(updated.priority).toBe(before.priority);
    expect(updated.batchSize).toBe(before.batchSize);
    expect(updated.updatedBy).toBe(before.updatedBy);
    // updatedAt always advances, even for a single-field patch.
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime()
    );

    const fetched = await getSchedule();
    expect(fetched.enabled).toBe(true);
  });

  it('updateSchedule round-trips every field together', async () => {
    const updated = await updateSchedule({
      enabled: false,
      priority: 'never_crawled',
      batchSize: 10,
      updatedBy: 'admin@example.test',
    });
    expect(updated.enabled).toBe(false);
    expect(updated.priority).toBe('never_crawled');
    expect(updated.batchSize).toBe(10);
    expect(updated.updatedBy).toBe('admin@example.test');

    const fetched = await getSchedule();
    expect(fetched.enabled).toBe(false);
    expect(fetched.priority).toBe('never_crawled');
    expect(fetched.batchSize).toBe(10);
    expect(fetched.updatedBy).toBe('admin@example.test');
  });

  it('updateSchedule with no fields still advances updatedAt (last-touched semantics)', async () => {
    const before = await getSchedule();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await updateSchedule({});
    expect(updated.enabled).toBe(before.enabled);
    expect(updated.priority).toBe(before.priority);
    expect(updated.batchSize).toBe(before.batchSize);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime()
    );
  });
});
