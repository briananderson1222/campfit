import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';

export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const campIds: string[] | undefined = body.campIds;

  let resolveRunId!: (id: string) => void;
  const runIdPromise = new Promise<string>(resolve => { resolveRunId = resolve; });

  // Start pipeline — it emits 'started' event with runId synchronously at boot
  runCrawlPipeline({
    triggeredBy: user.email,
    trigger: 'MANUAL',
    campIds,
    onProgress: (event) => {
      if (event.type === 'started') resolveRunId(event.runId);
    },
  }).catch(console.error);

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
