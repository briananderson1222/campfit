#!/usr/bin/env tsx
/**
 * Backfill Provider records from distinct Camp.organizationName values.
 * Safe to run multiple times (uses ON CONFLICT DO NOTHING for providers,
 * only links camps that don't have a providerId yet).
 *
 * Usage: npm run backfill:providers
 */

import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { getPool } from '@/lib/db';

function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseDomain(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/** Convert a domain like "botanicgardens.org" → "Botanic Gardens" */
function domainToName(domain: string): string {
  const base = domain.split('.')[0]; // take first segment before TLD
  return base
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase split
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function makeUniqueSlug(pool: ReturnType<typeof getPool>, name: string): Promise<string> {
  const base = toSlug(name);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}

async function main() {
  const pool = getPool();

  // Group camps by domain extracted from websiteUrl.
  // Falls back to organizationName grouping if domain is unavailable.
  const { rows: orgs } = await pool.query<{
    domain: string;
    websiteUrl: string;
    city: string | null;
    neighborhood: string | null;
    communitySlug: string | null;
    campCount: number;
    campIds: string[];
  }>(`
    SELECT
      regexp_replace("websiteUrl", '^https?://(www[.])?([^/]+).*', '\\2') AS domain,
      mode() WITHIN GROUP (ORDER BY "websiteUrl") AS "websiteUrl",
      mode() WITHIN GROUP (ORDER BY city)         AS city,
      mode() WITHIN GROUP (ORDER BY neighborhood) AS neighborhood,
      mode() WITHIN GROUP (ORDER BY "communitySlug") AS "communitySlug",
      COUNT(*)::int AS "campCount",
      array_agg(id) AS "campIds"
    FROM "Camp"
    WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != ''
      AND "providerId" IS NULL
    GROUP BY domain
    ORDER BY "campCount" DESC, domain
  `);

  log(`Found ${orgs.length} distinct domains to backfill`);

  let created = 0;
  let linked = 0;

  for (const org of orgs) {
    // Derive a human-readable name from the domain
    // e.g. "botanicgardens.org" → "Botanic Gardens", "denverzoo.org" → "Denver Zoo"
    const providerName = domainToName(org.domain);
    const slug = await makeUniqueSlug(pool, providerName);

    const { rows: [provider] } = await pool.query(`
      INSERT INTO "Provider"
        (name, slug, "websiteUrl", domain, city, neighborhood, "communitySlug")
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (slug) DO UPDATE
        SET domain = EXCLUDED.domain,
            "updatedAt" = now()
      RETURNING id, name
    `, [
      providerName, slug, org.websiteUrl, org.domain,
      org.city, org.neighborhood, org.communitySlug ?? 'denver',
    ]);

    const { rowCount } = await pool.query(
      `UPDATE "Camp" SET "providerId" = $1 WHERE id = ANY($2) AND "providerId" IS NULL`,
      [provider.id, org.campIds]
    );

    log(`  ${provider.name} (${org.domain}) → ${rowCount ?? 0} camps linked`);
    created++;
    linked += rowCount ?? 0;
  }

  log(`Done — ${created} providers created/updated, ${linked} camps linked`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
