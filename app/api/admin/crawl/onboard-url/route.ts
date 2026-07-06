import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { discoverCampsFromUrl, filterNewDiscoveries } from '@/lib/ingestion/llm-discovery';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { requireAdminAccess } from '@/lib/admin/access';
import { parseDomain } from '@/lib/admin/onboarding-validation';

export const maxDuration = 300;

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
  const body = await req.json().catch(() => ({}));
  const url: string = typeof body.url === 'string' ? body.url.trim() : '';
  const communitySlug = typeof body.communitySlug === 'string' && body.communitySlug.trim()
    ? body.communitySlug.trim()
    : 'denver';
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!url) return NextResponse.json({ error: 'URL required' }, { status: 400 });

  const domain = parseDomain(url);
  if (!domain) return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });

  const pool = getPool();

  // Find or create a provider for this domain
  const { rows: existing } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM "Provider" WHERE domain = $1 LIMIT 1`, [domain]
  );

  const providerCreated = existing.length === 0;
  let providerId: string;
  if (existing.length > 0) {
    providerId = existing[0].id;
  } else {
    const name = domainToName(domain);
    const slug = await makeUniqueSlug(pool, name);
    const { rows: [created] } = await pool.query<{ id: string }>(
      `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, "crawlRootUrl", "communitySlug")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET domain = EXCLUDED.domain RETURNING id`,
      [name, slug, url, domain, url, communitySlug]
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

  // R5/AC5 (campfit#90): every discovered program already existing is an
  // informational outcome, not an error — 200 with created:0 and the full
  // skipped-names breakdown, no crawl triggered. All other error branches
  // above (missing/invalid url, discovery failure, no stubs found) are
  // unchanged and keep their existing status codes.
  if (newStubs.length === 0) {
    const skippedNames = discovery.stubs.map(s => s.name);
    return NextResponse.json({
      providerId,
      providerCreated,
      discovered: discovery.stubs.length,
      created: 0,
      createdNames: [],
      skipped: skippedNames.length,
      skippedNames,
    });
  }

  // Names filtered out by filterNewDiscoveries, for the created/skipped
  // breakdown (R5/AC5) — computed by reference, since filterNewDiscoveries
  // returns a subset of the same stub objects.
  const newStubsSet = new Set(newStubs);
  const skippedNames = discovery.stubs.filter(s => !newStubsSet.has(s)).map(s => s.name);

  // Insert new camp stubs
  const newCampIds: string[] = [];
  for (const stub of newStubs) {
    const campUrl = stub.detailUrl ?? url;
    const campSlug = toSlug(stub.name) + '-' + Math.random().toString(36).slice(2, 6);
    const { rows: [camp] } = await pool.query<{ id: string }>(
      `INSERT INTO "Camp" (name, slug, "websiteUrl", "communitySlug", "dataConfidence", "campType", category, "campTypes", "categories", "providerId")
       VALUES ($1, $2, $3, $4, 'PLACEHOLDER', 'SUMMER_DAY', 'OTHER', ARRAY['SUMMER_DAY'], ARRAY['OTHER'], $5)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [stub.name, campSlug, campUrl, communitySlug, providerId]
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
    triggeredBy: auth.access.email,
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
    return NextResponse.json({
      runId,
      providerId,
      providerCreated,
      discovered: discovery.stubs.length,
      created: newStubs.length,
      createdNames: newStubs.map(s => s.name),
      skipped: skippedNames.length,
      skippedNames,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
