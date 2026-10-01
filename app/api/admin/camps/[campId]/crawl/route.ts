import { NextResponse } from 'next/server';
import { logAndMapPublicEgressError } from '@/lib/security/public-egress-error';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { CrawlSchemaOutdatedError, getCampCrawlTarget } from '@/lib/admin/crawl-repository';

export const maxDuration = 300;

export async function POST(req: Request, props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const model: string | undefined = typeof body.model === 'string' ? body.model : undefined;

  const camp = await getCampCrawlTarget(params.campId);

  if (!camp) return NextResponse.json({ error: 'Camp not found' }, { status: 404 });
  if (!camp.websiteUrl) return NextResponse.json({ error: 'Camp has no websiteUrl to crawl' }, { status: 400 });

  // A reviewer asked for this recrawl: extract even if the page text is
  // unchanged. The pending proposal is NOT skipped up front: writing the new
  // proposal supersedes it (createProposal), and if the crawl writes nothing
  // (no changes, an error) it must survive.

  // Fire-and-forget — same pattern as /api/admin/crawl/start
  let resolveRunId!: (id: string) => void;
  let rejectRunId!: (err: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve;
    rejectRunId = reject;
  });

  // campfit#53 (spa-ingestion): no `fetchOptions.renderImpl` is configured here —
  // this is a Vercel serverless route, which cannot launch headless Chromium (see
  // scripts/scrape.ts's file doc). A `render: true`/`requiresRender: true` source
  // recrawled from here fails closed with traverse's typed `invalid-config`
  // FetchError instead of a crash or a silent unrendered fetch (AC6/AC7).
  runCrawlPipeline({
    triggeredBy: auth.access.email,
    trigger: 'MANUAL',
    campIds: [params.campId],
    model,
    forceExtract: true,
    onProgress: (event) => {
      if (event.type === 'started') resolveRunId(event.runId);
    },
  }).catch(err => {
    rejectRunId(err instanceof Error ? err : new Error(String(err)));
    console.error('[camps/crawl] pipeline error:', err);
  });

  try {
    const runId = await Promise.race([
      runIdPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for crawl to start')), 5000)
      ),
    ]);
    return NextResponse.json({ runId });
  } catch (err) {
    // An operator-fixable setup fault: say what to do, not "request failed".
    if (err instanceof CrawlSchemaOutdatedError) return NextResponse.json({ error: err.message }, { status: 500 });
    return NextResponse.json({ error: logAndMapPublicEgressError('[camps/crawl] failed to start:', err) }, { status: 500 });
  }
}
