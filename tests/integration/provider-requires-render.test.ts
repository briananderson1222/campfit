/**
 * tests/integration/provider-requires-render.test.ts — campfit#53
 * (spa-ingestion), Wave 1 Task 1.2: `Provider.requiresRender` (migration
 * 019_provider_requires_render.sql) schema/repo/route round trip.
 *
 * Covers:
 *   - A fresh `resetTestDatabase()` run creates the column with the
 *     migration's own default (`false`) — implicitly proven by every other
 *     integration test in this suite running against a freshly-reset DB
 *     (`global-setup.ts`), but asserted directly here too.
 *   - `PATCH /api/admin/providers/[id]` with `{requiresRender: true}`
 *     persists via `updateProvider`'s whitelist (Task 1.2's repo change) and
 *     round-trips through `GET /api/admin/providers/[id]`.
 *   - `createProvider` (no `requiresRender` in the input) leaves the column
 *     at its migration default rather than requiring every caller to pass it.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

const { requireAdminAccessMock } = vi.hoisted(() => ({ requireAdminAccessMock: vi.fn() }));

vi.mock('@/lib/admin/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/access')>();
  return {
    ...actual,
    requireAdminAccess: requireAdminAccessMock,
  };
});

import { GET, PATCH } from '@/app/api/admin/providers/[providerId]/route';
import { createProvider } from '@/lib/admin/provider-repository';

const ADMIN_ACCESS = {
  access: {
    userId: 'test-admin',
    email: 'admin@campfit.test',
    isAdmin: true,
    isModerator: false,
    communities: ['denver'],
  },
};

let pool: Pool;

beforeAll(async () => {
  await assertTestDatabase();
  pool = getTestPool();
});

beforeEach(() => {
  requireAdminAccessMock.mockReset();
  requireAdminAccessMock.mockResolvedValue(ADMIN_ACCESS);
});

afterEach(async () => {
  await pool.query(`TRUNCATE "Provider" CASCADE`);
});

afterAll(async () => {
  await closeTestPool();
});

function patchRequest(providerId: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/providers/${providerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Provider.requiresRender (migration 019, campfit#53)', () => {
  it('defaults to false on the migration column when a fresh Provider row is created directly', async () => {
    const { rows } = await pool.query<{ requiresRender: boolean }>(
      `INSERT INTO "Provider" (name, slug) VALUES ($1, $2) RETURNING "requiresRender"`,
      [`Raw Insert ${randomUUID()}`, `raw-${randomUUID()}`],
    );
    expect(rows[0].requiresRender).toBe(false);
  });

  it('createProvider leaves requiresRender at its migration default (false) when the caller does not set it', async () => {
    const provider = await createProvider({ name: `No Render Flag ${randomUUID()}` });
    expect(provider.requiresRender).toBe(false);
  });

  it('PATCH {requiresRender: true} persists and round-trips through GET', async () => {
    const provider = await createProvider({ name: `Render Flag ${randomUUID()}` });
    expect(provider.requiresRender).toBe(false);

    const patchRes = await PATCH(patchRequest(provider.id, { requiresRender: true }), {
      params: Promise.resolve({ providerId: provider.id }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.requiresRender).toBe(true);

    const getRes = await GET(new Request(`http://localhost/api/admin/providers/${provider.id}`), {
      params: Promise.resolve({ providerId: provider.id }),
    });
    expect(getRes.status).toBe(200);
    const { provider: fetched } = await getRes.json();
    expect(fetched.requiresRender).toBe(true);
  });

  it('PATCH {requiresRender: false} flips it back off', async () => {
    const provider = await createProvider({ name: `Render Flag Off ${randomUUID()}` });
    await PATCH(patchRequest(provider.id, { requiresRender: true }), {
      params: Promise.resolve({ providerId: provider.id }),
    });

    const patchRes = await PATCH(patchRequest(provider.id, { requiresRender: false }), {
      params: Promise.resolve({ providerId: provider.id }),
    });
    const patched = await patchRes.json();
    expect(patched.requiresRender).toBe(false);
  });
});
