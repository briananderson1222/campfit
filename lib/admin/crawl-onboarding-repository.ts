import { getPool } from '@/lib/db';

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export async function findOrCreateCrawlProvider(input: {
  domain: string; name: string; url: string; communitySlug: string;
}): Promise<{ providerId: string; providerCreated: boolean }> {
  const pool = getPool();
  const { rows: existing } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "Provider" WHERE domain = $1 LIMIT 1`, [input.domain]);
  if (existing.length > 0) return { providerId: existing[0].id, providerCreated: false };
  const base = toSlug(input.name);
  let slug = base;
  let attempt = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
    if (rows.length === 0) break;
    slug = `${base}-${attempt++}`;
  }
  const { rows: [created] } = await pool.query<{ id: string }>(
    `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, "crawlRootUrl", "communitySlug")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain RETURNING id`,
    [input.name, slug, input.url, input.domain, input.url, input.communitySlug]);
  return { providerId: created.id, providerCreated: true };
}

export async function listCampNamesForWebsiteDomain(domain: string): Promise<string[]> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT name FROM "Camp" WHERE "websiteUrl" LIKE $1`, [`%${domain}%`]);
  return rows.map((row) => row.name);
}

export type DiscoveredCampStubInput = {
  name: string; slug: string; websiteUrl: string; communitySlug: string;
  providerId: string; fieldSourcesJson: string;
};

export async function insertDiscoveredCampStub(input: DiscoveredCampStubInput): Promise<string | null> {
  const { rows: [camp] } = await getPool().query<{ id: string }>(
    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories", "providerId", "fieldSources")
     VALUES ($1, $2, $3, $4, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $5, $6::jsonb)
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [input.name, input.slug, input.websiteUrl, input.communitySlug, input.providerId, input.fieldSourcesJson]);
  return camp?.id ?? null;
}
