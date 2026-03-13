import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProviderCommunitySlug } from '@/lib/admin/community-access';

export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: { providerId: string } }
) {
  const communitySlug = await getProviderCommunitySlug(params.providerId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const discover: boolean = body.discover === true;
  const model: string | undefined = typeof body.model === 'string' ? body.model : undefined;

  const pool = getPool();

  // Fetch provider info (for crawlRootUrl) and its camp IDs
  const [providerRes, campsRes] = await Promise.all([
    pool.query<{ crawlRootUrl: string | null; websiteUrl: string | null }>(
      `SELECT "crawlRootUrl", "websiteUrl" FROM "Provider" WHERE id = $1`,
      [params.providerId]
    ),
    pool.query<{ id: string }>(
      `SELECT id FROM "Camp" WHERE "providerId" = $1 AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`,
      [params.providerId]
    ),
  ]);

  const campIds = campsRes.rows.map(r => r.id);

  if (campIds.length === 0 && !discover) {
    return NextResponse.json({ error: 'No crawlable camps for this provider' }, { status: 400 });
  }

  // If doing discovery with no existing camps, we need at least a root URL to crawl
  const provider = providerRes.rows[0];
  if (campIds.length === 0 && discover && !provider?.crawlRootUrl && !provider?.websiteUrl) {
    return NextResponse.json({ error: 'No camps and no website URL — cannot discover' }, { status: 400 });
  }

  let resolveRunId!: (id: string) => void;
  let rejectRunId!: (err: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve;
    rejectRunId = reject;
  });

  runCrawlPipeline({
    triggeredBy: auth.access.email,
    trigger: 'MANUAL',
    providerIds: [params.providerId],
    model,
    discover,
    onProgress: (event) => {
      if (event.type === 'started') resolveRunId(event.runId);
    },
  }).catch(err => {
    rejectRunId(err instanceof Error ? err : new Error(String(err)));
    console.error('[providers/crawl] pipeline error:', err);
  });

  try {
    const runId = await Promise.race([
      runIdPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for run to start')), 5000)
      ),
    ]);
    return NextResponse.json({ runId, campCount: campIds.length, discover });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
