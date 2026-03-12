import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';
import { discoverCampsFromUrl, filterNewDiscoveries } from '@/lib/ingestion/llm-discovery';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';

export const maxDuration = 300;

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function domainToName(domain: string): string {
  const base = domain.split('.')[0];
  return base.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function makeUniqueSlug(pool: any, name: string): Promise<string> {
  const base = toSlug(name);
  let slug = base, attempt = 2;
  while (true) {
    const { rows } = await pool.query('SELECT 1 FROM "Provider" WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${attempt++}`;
  }
}

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const url: string = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return NextResponse.json({ error: 'URL required' }, { status: 400 });

  const domain = parseDomain(url);
  if (!domain) return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });

  const pool = getPool();

  // Find or create a provider for this domain
  const { rows: existing } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "Provider" WHERE domain = $1 LIMIT 1`, [domain]
  );

  let providerId: string;
  if (existing.length > 0) {
    providerId = existing[0].id;
  } else {
    const name = domainToName(domain);
    const slug = await makeUniqueSlug(pool, name);
    const { rows: [created] } = await pool.query<{ id: string }>(
      `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, "crawlRootUrl", "communitySlug")
       VALUES ($1, $2, $3, $4, $5, 'denver')
       ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain RETURNING id`,
      [name, slug, url, domain, url]
    );
    providerId = created.id;
  }

  // Run discovery on the URL
  const discovery = await discoverCampsFromUrl(url, {}).catch(() => null);
  if (!discovery || discovery.error || !discovery.stubs.length) {
    return NextResponse.json({ error: discovery?.error ?? 'No camps found on that page. Try the camp\'s programs or schedule page.' }, { status: 422 });
  }

  // Filter against any existing camps from this domain
  const { rows: existingCamps } = await pool.query<{ name: string }>(
    `SELECT name FROM "Camp" WHERE "websiteUrl" LIKE $1`, [`%${domain}%`]
  );
  const existingNames = existingCamps.map(r => r.name);
  const newStubs = filterNewDiscoveries(discovery.stubs, existingNames);

  if (newStubs.length === 0) {
    return NextResponse.json({ error: 'All discovered programs already exist in the database.' }, { status: 422 });
  }

  // Insert new camp stubs
  const newCampIds: string[] = [];
  for (const stub of newStubs) {
    const campUrl = stub.detailUrl ?? url;
    const campSlug = toSlug(stub.name) + '-' + Math.random().toString(36).slice(2, 6);
    const { rows: [camp] } = await pool.query<{ id: string }>(
      `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
       VALUES ($1, $2, $3, 'denver', 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $4)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [stub.name, campSlug, campUrl, providerId]
    );
    if (camp) newCampIds.push(camp.id);
  }

  if (newCampIds.length === 0) {
    return NextResponse.json({ error: 'Could not create camp records.' }, { status: 500 });
  }

  // Fire-and-forget crawl on the new camps
  let resolveRunId!: (id: string) => void;
  let rejectRunId!: (err: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve; rejectRunId = reject;
  });

  runCrawlPipeline({
    triggeredBy: user.email!,
    trigger: 'MANUAL',
    campIds: newCampIds,
    onProgress: (event) => {
      if (event.type === 'started') resolveRunId(event.runId);
    },
  }).catch(err => {
    rejectRunId(err instanceof Error ? err : new Error(String(err)));
    console.error('[onboard-url] pipeline error:', err);
  });

  try {
    const runId = await Promise.race([
      runIdPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for run to start')), 5000)),
    ]);
    return NextResponse.json({ runId, providerId, discovered: newStubs.length, creating: newCampIds.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
