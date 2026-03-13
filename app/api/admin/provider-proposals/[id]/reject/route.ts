import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const pool = getPool();
  const proposalRes = await pool.query(
    `SELECT pcp.id, pcp.status, p."communitySlug"
     FROM "ProviderChangeProposal" pcp
     JOIN "Provider" p ON p.id = pcp."providerId"
     WHERE pcp.id = $1`,
    [params.id],
  );
  const proposal = proposalRes.rows[0];
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireAdminAccess({ communitySlug: proposal.communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({})) as { reviewerNotes?: string };
  const { rowCount } = await pool.query(
    `UPDATE "ProviderChangeProposal"
     SET status = 'REJECTED', "reviewedAt" = now(), "reviewedBy" = $2, "reviewerNotes" = $3
     WHERE id = $1 AND status = 'PENDING'`,
    [params.id, auth.access.email, body.reviewerNotes?.trim() || null],
  );
  if (!rowCount) return NextResponse.json({ error: 'Not found or already reviewed' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
