import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getPool } from '@/lib/db';
import { runCrawlPipeline } from '@/lib/ingestion/crawl-pipeline';

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

  // Immediately skip any existing PENDING proposals for this camp so it
  // falls out of the review queue until the new crawl produces a replacement.
  await pool.query(
    `UPDATE "CampChangeProposal" SET status = 'SKIPPED', "updatedAt" = now()
     WHERE "campId" = $1 AND status = 'PENDING'`,
    [params.campId]
  );

  const run = await runCrawlPipeline({
    triggeredBy: user.email,
    trigger: 'MANUAL',
    campIds: [params.campId],
  });

  return NextResponse.json({ runId: run.id, status: run.status });
}
