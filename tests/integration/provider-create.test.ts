/**
 * tests/integration/provider-create.test.ts — campfit#90 Wave 2 Task A
 * (R1/AC1, R2/AC2): server-side URL validation + domain dedupe on manual
 * provider create.
 *
 * Coverage:
 *   AC1 — `POST /api/admin/providers` rejects an invalid `websiteUrl` /
 *         `crawlRootUrl` with 400 even when the client-side check is
 *         bypassed (a real `Request` through the route's exported `POST`,
 *         not just a unit test of `isValidHttpUrl`).
 *   AC2 — a domain match against an existing, non-archived `Provider` is
 *         blocked with 409, creates no new row; an archived match does not
 *         block (accepted scope per the plan); a non-duplicate, valid
 *         create still succeeds exactly as today. An admin (or a moderator
 *         who has visibility into the matched provider's community) gets
 *         the existing provider's id/name/slug in the 409 body; a moderator
 *         scoped to a *different* community gets a generic 409 with no
 *         identity fields — the dedupe still blocks cross-community, but
 *         never discloses another community's provider identity (review
 *         finding: cross-tenant leak via domain dedupe 409).
 *
 * F1 defense-in-depth: all seed/truncate/assert SQL goes through
 * `./test-db`'s `getTestPool()`, and `beforeAll` awaits
 * `assertTestDatabase()` before anything destructive runs (see
 * `provider-discovery.test.ts` for the established precedent).
 *
 * `requireAdminAccess` is mocked (not the real Supabase-session lookup —
 * that has no test-harness precedent in this repo yet) so the route's own
 * validation/dedupe logic can be exercised through a real `Request` object;
 * every `Provider` assertion still goes through the real test DB. The mock
 * is backed by `evaluateAdminAccess` — the module's *real*, unmocked
 * community-scoping evaluator — so that simulating "a moderator of
 * community X" (for the cross-community dedupe test below) exercises the
 * same auth decision logic every other route relies on, rather than a
 * hand-rolled stand-in.
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

import { evaluateAdminAccess } from '@/lib/admin/access';
import { POST } from '@/app/api/admin/providers/route';
import { createProvider, findProviderByDomain } from '@/lib/admin/provider-repository';

const ADMIN_ACCESS = {
  access: {
    userId: 'test-admin',
    email: 'admin@campfit.test',
    isAdmin: true,
    isModerator: false,
    communities: ['denver'],
  },
};

/** Simulates a real (non-admin) moderator via the actual `evaluateAdminAccess`. */
function mockAsModerator(communitySlug: string) {
  requireAdminAccessMock.mockImplementation(
    async (opts?: { communitySlug?: string | null; allowModerator?: boolean }) =>
      evaluateAdminAccess({
        userId: `mod-${communitySlug}`,
        email: `moderator@${communitySlug}.test`,
        isAdmin: false,
        assignments: [{ communitySlug, role: 'MODERATOR' }],
        requestedCommunity: opts?.communitySlug,
        allowModerator: opts?.allowModerator,
      }),
  );
}

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

async function insertProvider(input: {
  name: string;
  domain: string | null;
  archivedAt?: Date | null;
  communitySlug?: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "Provider" (name, slug, domain, "communitySlug", "archivedAt")
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.name, `prov-${randomUUID()}`, input.domain, input.communitySlug ?? 'denver', input.archivedAt ?? null],
  );
  return rows[0].id;
}

async function providerCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "Provider"`);
  return Number(rows[0].count);
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── AC1: server-side URL validation ─────────────────────────────────────────

describe('AC1 — server-side URL validation on POST /api/admin/providers', () => {
  it('rejects an invalid websiteUrl with 400 and creates no row', async () => {
    const res = await POST(postRequest({ name: 'Bad URL Provider', websiteUrl: 'not a url' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/valid http/i);
    expect(await providerCount()).toBe(0);
  });

  it('rejects an invalid crawlRootUrl with 400 and creates no row', async () => {
    const res = await POST(postRequest({ name: 'Bad Crawl Root', crawlRootUrl: 'ftp://example.com' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/valid http/i);
    expect(await providerCount()).toBe(0);
  });

  it('accepts a valid, non-duplicate create exactly as today', async () => {
    const res = await POST(postRequest({
      name: 'Good Provider',
      websiteUrl: 'https://good-provider.example',
      crawlRootUrl: 'https://good-provider.example/programs',
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeTruthy();
    expect(data.domain).toBe('good-provider.example');
    expect(await providerCount()).toBe(1);
  });

  it('treats missing websiteUrl/crawlRootUrl as valid (optional fields)', async () => {
    const res = await POST(postRequest({ name: 'No URLs Provider' }));
    expect(res.status).toBe(201);
    expect(await providerCount()).toBe(1);
  });
});

// ── AC2: domain dedupe ───────────────────────────────────────────────────────

describe('AC2 — domain dedupe on POST /api/admin/providers', () => {
  it('blocks a create matching an existing, non-archived provider domain with 409', async () => {
    const existingId = await insertProvider({ name: 'Existing Rec Center', domain: 'existing-rec.example' });

    const res = await POST(postRequest({
      name: 'Duplicate Rec Center',
      websiteUrl: 'https://existing-rec.example/summer-camps',
    }));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already exists/i);
    expect(data.existingProviderId).toBe(existingId);
    expect(data.existingProviderName).toBe('Existing Rec Center');
    expect(data.existingProviderSlug).toBeTruthy();
    // No new row created — only the seeded one remains.
    expect(await providerCount()).toBe(1);
  });

  it('does not block a create matching only an archived provider domain', async () => {
    await insertProvider({
      name: 'Archived Rec Center',
      domain: 'archived-rec.example',
      archivedAt: new Date(),
    });

    const res = await POST(postRequest({
      name: 'Fresh Rec Center',
      websiteUrl: 'https://archived-rec.example/summer-camps',
    }));

    expect(res.status).toBe(201);
    expect(await providerCount()).toBe(2);
  });

  it('finds no match for an unrelated domain', async () => {
    await insertProvider({ name: 'Unrelated Provider', domain: 'unrelated.example' });

    const res = await POST(postRequest({
      name: 'New Provider',
      websiteUrl: 'https://brand-new.example',
    }));

    expect(res.status).toBe(201);
    expect(await providerCount()).toBe(2);
  });
});

// ── AC2 cross-community identity disclosure (review finding: HIGH cross-
// tenant leak via domain dedupe 409) ────────────────────────────────────────

describe('AC2 — domain dedupe 409 identity disclosure is community-scoped', () => {
  it('an admin sees the matched provider identity regardless of its community', async () => {
    const existingId = await insertProvider({
      name: 'Boulder Rec Center',
      domain: 'boulder-rec.example',
      communitySlug: 'boulder',
    });
    // ADMIN_ACCESS is the default mock (isAdmin: true) — no override needed.

    const res = await POST(postRequest({
      name: 'Duplicate Boulder Rec',
      websiteUrl: 'https://boulder-rec.example/camps',
      communitySlug: 'boulder',
    }));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already exists/i);
    expect(data.existingProviderId).toBe(existingId);
    expect(data.existingProviderName).toBe('Boulder Rec Center');
    expect(data.existingProviderSlug).toBeTruthy();
    expect(await providerCount()).toBe(1);
  });

  it('a moderator scoped to the SAME community as the match sees the identity', async () => {
    const existingId = await insertProvider({
      name: 'Denver Rec Center',
      domain: 'denver-rec.example',
      communitySlug: 'denver',
    });
    mockAsModerator('denver');

    const res = await POST(postRequest({
      name: 'Duplicate Denver Rec',
      websiteUrl: 'https://denver-rec.example/camps',
      communitySlug: 'denver',
    }));

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.existingProviderId).toBe(existingId);
    expect(data.existingProviderName).toBe('Denver Rec Center');
    expect(await providerCount()).toBe(1);
  });

  it('a moderator scoped to a DIFFERENT community than the match still gets blocked, but with a generic 409 and no identity fields', async () => {
    const existingId = await insertProvider({
      name: 'Denver Rec Center',
      domain: 'denver-rec.example',
      communitySlug: 'denver',
    });
    // This moderator is only assigned to 'boulder' — they submit their own
    // (authorized) community, but the domain match lives in 'denver', which
    // they have no visibility into.
    mockAsModerator('boulder');

    const res = await POST(postRequest({
      name: 'Sneaky Duplicate',
      websiteUrl: 'https://denver-rec.example/camps',
      communitySlug: 'boulder',
    }));

    // Still blocked — duplicates are global, not scoped to the requester's community.
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already exists/i);
    // But no identity fields — the requester has no visibility into 'denver'.
    expect(data.existingProviderId).toBeUndefined();
    expect(data.existingProviderName).toBeUndefined();
    expect(data.existingProviderSlug).toBeUndefined();
    // No new row created — the block is real, not merely the disclosure.
    expect(await providerCount()).toBe(1);
    // Confirms the existing provider really does belong to a different
    // community than the one the moderator is scoped to.
    const found = await findProviderByDomain('denver-rec.example');
    expect(found?.id).toBe(existingId);
    expect(found?.communitySlug).toBe('denver');
  });
});

// ── findProviderByDomain / createProvider (direct repository coverage) ──────

describe('findProviderByDomain', () => {
  it('matches a non-archived provider by normalized domain', async () => {
    const id = await insertProvider({ name: 'Direct Match Co', domain: 'direct-match.example' });
    const found = await findProviderByDomain('direct-match.example');
    expect(found?.id).toBe(id);
    expect(found?.name).toBe('Direct Match Co');
  });

  it('does not match an archived provider', async () => {
    await insertProvider({ name: 'Archived Co', domain: 'archived-direct.example', archivedAt: new Date() });
    expect(await findProviderByDomain('archived-direct.example')).toBeNull();
  });

  it('returns null when no provider has that domain', async () => {
    expect(await findProviderByDomain('nobody-has-this.example')).toBeNull();
  });
});

describe('createProvider (regression: unchanged happy path)', () => {
  it('still creates a provider with a computed domain when called directly', async () => {
    const provider = await createProvider({
      name: 'Direct Call Provider',
      websiteUrl: 'https://www.direct-call.example/home',
    });
    expect(provider.domain).toBe('direct-call.example');
    expect(await providerCount()).toBe(1);
  });
});
