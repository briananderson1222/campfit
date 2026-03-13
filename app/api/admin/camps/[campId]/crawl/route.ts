import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';

export const maxDuration = 300;

export async function POST(
  _req: Request,
  { params }: { params: { campId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; websiteUrl: string | null }>(
    `SELECT id, "websiteUrl" FROM "Camp" WHERE id = $1`,
    [params.campId]
  );

  if (rows.length === 0) return NextResponse.json({ error: 'Camp not found' }, { status: 404 });
  if (!rows[0].websiteUrl) return NextResponse.json({ error: 'Camp has no websiteUrl to crawl' }, { status: 400 });

  // Skip any existing PENDING proposals so they fall out of the review queue
  await pool.query(
    `UPDATE "CampChangeProposal" SET status = 'SKIPPED'
     WHERE "campId" = $1 AND status = 'PENDING'`,
    [params.campId]
  );

  // Fire-and-forget — same pattern as /api/admin/crawl/start
  let resolveRunId!: (id: string) => void;
  let rejectRunId!: (err: Error) => void;
  const runIdPromise = new Promise<string>((resolve, reject) => {
    resolveRunId = resolve;
    rejectRunId = reject;
  });

  runCrawlPipeline({
    triggeredBy: user.email,
    trigger: 'MANUAL',
    campIds: [params.campId],
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
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
