import { getCrawlRun } from '@/lib/admin/crawl-repository';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const timeout = Date.now() + 15 * 60 * 1000; // 15 min max

      while (Date.now() < timeout) {
        const run = await getCrawlRun(params.runId);
        if (!run) { controller.close(); return; }

        send({
          type: run.status === 'RUNNING'
            ? 'progress'
            : run.status === 'COMPLETED'
              ? 'completed'
              : 'failed',
          runId: run.id,
          totalCamps: run.totalCamps,
          processedCamps: run.processedCamps,
          errorCount: run.errorCount,
          newProposals: run.newProposals,
          stats: {
            processedCamps: run.processedCamps,
            errorCount: run.errorCount,
            newProposals: run.newProposals,
          },
        });

        if (run.status !== 'RUNNING') { controller.close(); return; }
        await new Promise(r => setTimeout(r, 2000));
      }

      send({ type: 'failed', runId: params.runId, error: 'Timed out' });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
