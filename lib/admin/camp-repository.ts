/**
 * lib/admin/camp-repository.ts — admin camp-create repository (campfit#90
 * Wave 2 Task B / R3 / AC3). Mirrors `provider-repository.ts`'s
 * `createProvider`/`makeUniqueSlug` shape. Raw `pg` via `getPool()` only —
 * no Prisma Client (`prisma/schema.prisma` is schema-as-documentation here,
 * see `scripts/test-db-reset.ts`'s header comment).
 */
import { getPool } from '@/lib/db';
import type { Camp, CampType, CampCategory } from '@/lib/types';
import { isValidHttpUrl } from './onboarding-validation';

function db() {
  return getPool();
}

/**
 * Thrown for any camp-create input problem the route should surface as a
 * 400: missing/blank `providerId`, a `providerId` that doesn't resolve to an
 * existing non-archived `Provider` (camp create must never orphan a camp —
 * see the plan's "Camp-create bypassing provider linkage" stop-short risk),
 * or an invalid `websiteUrl`.
 */
export class CampCreateValidationError extends Error {}

type CreateCampInput = {
  name: string;
  providerId: string;
  campType: CampType;
  category: CampCategory;
  websiteUrl?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  address?: string | null;
};

/**
 * Inserts a new `Camp` linked to an existing, non-archived `Provider`.
 * `campTypes`/`categories` are set to the single selected value
 * (`[campType]`/`[category]`), matching `onboard-url/route.ts`'s existing
 * single-value convention. New camps are unverified until crawled
 * (`dataConfidence: 'PLACEHOLDER'`), matching onboard-url's convention.
 */
export async function createCamp(input: CreateCampInput): Promise<Camp> {
  const providerId = input.providerId?.trim();
  if (!providerId) {
    throw new CampCreateValidationError('providerId is required');
  }
  if (!input.name?.trim()) {
    throw new CampCreateValidationError('name is required');
  }
  if (input.websiteUrl && !isValidHttpUrl(input.websiteUrl)) {
    throw new CampCreateValidationError('Website URL must be a valid http(s) URL');
  }

  const { rows: providerRows } = await db().query<{ id: string; communitySlug: string }>(
    `SELECT id, "communitySlug" FROM "Provider" WHERE id = $1 AND "archivedAt" IS NULL`,
    [providerId],
  );
  const provider = providerRows[0];
  if (!provider) {
    throw new CampCreateValidationError('providerId must reference an existing, non-archived provider');
  }

  const camp = await insertCampWithUniqueSlug(input, provider);
  return camp;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Inserts the Camp row, retrying with a suffixed slug candidate on a unique-
 * slug conflict. A check-then-insert (`SELECT ... WHERE slug = $1` followed
 * by a plain `INSERT`) has a TOCTOU race: two concurrent creates for the
 * same name could both pass the `SELECT` for the same candidate before
 * either inserts, and the losing `INSERT` would then throw a raw Postgres
 * unique-violation instead of a clean result. Using `INSERT ... ON CONFLICT
 * (slug) DO NOTHING RETURNING *` and retrying with the next candidate on a
 * miss closes that window — mirroring the same pattern `onboard-url/route.ts`
 * already uses for its own Provider/Camp inserts.
 */
async function insertCampWithUniqueSlug(
  input: CreateCampInput,
  provider: { id: string; communitySlug: string },
): Promise<Camp> {
  const base = slugify(input.name);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await db().query<Camp>(`
      INSERT INTO "Camp"
        (name, slug, "websiteUrl", "communitySlug", "providerId",
         "campType", category, "campTypes", "categories",
         city, neighborhood, address, "dataConfidence")
      VALUES ($1,$2,$3,$4,$5,$6,$7,ARRAY[$6]::"CampType"[],ARRAY[$7]::"CampCategory"[],$8,$9,$10,'PLACEHOLDER')
      ON CONFLICT (slug) DO NOTHING
      RETURNING *
    `, [
      input.name.trim(), slug, input.websiteUrl ?? '', provider.communitySlug, provider.id,
      input.campType, input.category,
      input.city ?? 'Denver', input.neighborhood ?? '', input.address ?? '',
    ]);
    if (rows[0]) return rows[0];
    slug = `${base}-${attempt++}`;
  }
}
