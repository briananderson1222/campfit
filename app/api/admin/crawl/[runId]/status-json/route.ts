import { NextResponse } from 'next/server';
import { getCrawlRun } from '@/lib/admin/crawl-repository';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampIdsCommunitySlugs } from '@/lib/admin/community-access';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const run = await getCrawlRun(params.runId);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!auth.access.isAdmin) {
    const communities = await getCampIdsCommunitySlugs(run.campIds ?? []);
    if (communities.length === 0 || !communities.every((community) => auth.access.communities.includes(community))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

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
