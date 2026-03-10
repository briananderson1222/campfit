import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';

export async function POST(
  _req: Request,
  { params }: { params: { providerId: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const pool = getPool();

  // Look up all camp IDs for this provider
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM "Camp" WHERE "providerId" = $1 AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`,
    [params.providerId]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No crawlable camps for this provider' }, { status: 400 });
  }

  const campIds = rows.map(r => r.id);

  // Fire-and-forget: start the crawl but don't wait for completion (Vercel timeout)
  // For local use or short provider lists this is fine; for large providers use the CLI.
  const run = await runCrawlPipeline({
    triggeredBy: user.email,
    trigger: 'MANUAL',
    campIds,
  });

  return NextResponse.json({ runId: run.id, campCount: campIds.length, status: run.status });
}
