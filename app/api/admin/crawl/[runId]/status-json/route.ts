import { NextResponse } from 'next/server';
import { getCrawlRun } from '@/lib/admin/crawl-repository';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  const run = await getCrawlRun(params.runId);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    status: run.status,
    processedCamps: run.processedCamps,
    totalCamps: run.totalCamps,
    newProposals: run.newProposals,
    errorCount: run.errorCount,
    campLog: run.campLog ?? [],
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    triggeredBy: run.triggeredBy,
    trigger: run.trigger,
  });
}
