import { NextResponse } from 'next/server';
import { buildDiscoveryFieldSources, discoverCampsFromUrl, filterNewDiscoveries } from '@/lib/ingestion/llm-discovery';
import { resolveExtractionProvider } from '@/lib/ingestion/resolve-extraction-provider';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { requireAdminAccess } from '@/lib/admin/access';
import { parseDomain } from '@/lib/admin/onboarding-validation';
import { EgressUrlPolicyError, evaluateEgressUrl } from '@/lib/security/egress-url-policy';
import { findOrCreateCrawlProvider, insertDiscoveredCampStub, listCampNamesForWebsiteDomain } from '@/lib/admin/crawl-onboarding-repository';

export const maxDuration = 300;

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function domainToName(domain: string): string {
  const base = domain.split('.')[0];
  return base.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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

  try {
    await evaluateEgressUrl(url, 'operatorDiscovery');
  } catch (error) {
    if (error instanceof EgressUrlPolicyError) {
      return NextResponse.json({ error: 'URL is not permitted for server-side discovery.' }, { status: 422 });
    }
    return NextResponse.json({ error: 'URL could not be validated for server-side discovery.' }, { status: 422 });
  }

  const domain = parseDomain(url);
  if (!domain) return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });

  // Find or create a provider for this domain
  const { providerId, providerCreated } = await findOrCreateCrawlProvider({
    domain, name: domainToName(domain), url, communitySlug,
  });

  // Run discovery on the URL
  let discoveryDeps: { provider: ReturnType<typeof resolveExtractionProvider>['provider']; store: ReturnType<typeof createCampfitSnapshotStore> };
  try {
    discoveryDeps = { provider: resolveExtractionProvider().provider, store: createCampfitSnapshotStore() };
  } catch (error) {
    console.error('[onboard-url] discovery provider unavailable:', error);
    return NextResponse.json({ error: 'Discovery provider is unavailable.' }, { status: 422 });
  }
  const discovery = await discoverCampsFromUrl(url, { ...discoveryDeps, egressProfile: 'operatorDiscovery' }).catch(() => null);
  if (!discovery) {
    return NextResponse.json({ error: 'No camps found on that page. Try the camp\'s programs or schedule page.' }, { status: 422 });
  }
  if (discovery.error) {
    return NextResponse.json({ error: 'Discovery failed for that URL' }, { status: 422 });
  }
  if (!discovery.stubs.length) {
    return NextResponse.json({ error: 'No camps found on that page. Try the camp\'s programs or schedule page.' }, { status: 422 });
  }

  // Filter against any existing camps from this domain
  const existingNames = await listCampNamesForWebsiteDomain(domain);
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
    const fieldSources = buildDiscoveryFieldSources(stub);
    const campId = await insertDiscoveredCampStub({
      name: stub.name,
      slug: campSlug,
      websiteUrl: campUrl,
      communitySlug,
      providerId,
      fieldSourcesJson: JSON.stringify(fieldSources),
    });
    if (campId) newCampIds.push(campId);
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

  // campfit#53 (spa-ingestion): no `fetchOptions.renderImpl` is configured here —
  // this is a Vercel serverless route, which cannot launch headless Chromium (see
  // scripts/scrape.ts's file doc). A `render: true`/`requiresRender: true` source
  // recrawled from here fails closed with traverse's typed `invalid-config`
  // FetchError instead of a crash or a silent unrendered fetch (AC6/AC7).
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
    console.error('[onboard-url] crawl start failed:', err);
    return NextResponse.json({ error: 'The crawl could not be started.' }, { status: 500 });
  }
}
