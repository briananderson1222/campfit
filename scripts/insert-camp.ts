import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { getPool } from '@/lib/db';

const url = process.argv[2];
const name = process.argv[3];
if (!url || !name) { console.error('Usage: tsx scripts/insert-camp.ts <url> <name>'); process.exit(1); }

async function main() {
  const pool = getPool();
  const domain = new URL(url).hostname.replace(/^www\./, '');

  const { rows: ep } = await pool.query('SELECT id, name FROM "Provider" WHERE domain = $1', [domain]);
  let providerId: string;
  if (ep.length > 0) {
    providerId = ep[0].id;
    console.log('Provider exists:', ep[0].name, providerId);
  } else {
    const provName = name;
    const slug = provName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const { rows: [p] } = await pool.query(
      `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, "crawlRootUrl", "communitySlug")
       VALUES ($1, $2, $3, $4, $3, 'denver') ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain RETURNING id`,
      [provName, slug, url, domain]
    );
    providerId = p.id;
    console.log('Created provider:', providerId);
  }

  const { rows: ec } = await pool.query('SELECT id FROM "Camp" WHERE "websiteUrl" = $1', [url]);
  if (ec.length > 0) { console.log('Camp already exists:', ec[0].id); await pool.end(); return ec[0].id; }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  const { rows: [camp] } = await pool.query(
    `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
     VALUES ($1, $2, $3, 'denver', 'PLACEHOLDER', 'SUMMER_DAY', 'MULTI_ACTIVITY', ARRAY['SUMMER_DAY'], ARRAY['MULTI_ACTIVITY'], $4)
     RETURNING id`,
    [name, slug, url, providerId]
  );
  console.log('Created camp:', camp.id);
  await pool.end();
  return camp.id;
}
main().catch(e => { console.error(e); process.exit(1); });
