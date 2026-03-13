import { NextResponse } from 'next/server';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampIdsCommunitySlugs } from '@/lib/admin/community-access';

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const campIds: string[] | undefined = body.campIds;
  const model: string | undefined = typeof body.model === 'string' ? body.model : undefined;
  const discover: boolean = body.discover === true;
  const communities = await getCampIdsCommunitySlugs(campIds ?? []);
  const communitySlug = communities.length === 1 ? communities[0] : null;
  const auth = await requireAdminAccess({ communitySlug, allowModerator: (campIds?.length ?? 0) > 0 && communities.length <= 1 });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.access.isModerator && communities.length > 1) {
    return NextResponse.json({ error: 'Moderators can only start crawls within a single assigned community' }, { status: 403 });
  }

  let resolveRunId!: (id: string) => void;
  let rejectRunId!: (err: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve;
    rejectRunId = reject;
  });

  // Start pipeline — it emits 'started' event with runId synchronously at boot
  runCrawlPipeline({
    triggeredBy: auth.access.email,
    trigger: 'MANUAL',
    campIds,
    model,
    discover,
    onProgress: (event) => {
      if (event.type === 'started') resolveRunId(event.runId);
    },
  }).catch(err => {
    rejectRunId(err instanceof Error ? err : new Error(String(err)));
    console.error('[crawl/start] pipeline error:', err);
  });

  // Wait for the run to be created (happens at pipeline start before any camp processing)
  try {
    const runId = await Promise.race([
      runIdPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for run to start')), 5000)
      ),
    ]);
    return NextResponse.json({ runId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
