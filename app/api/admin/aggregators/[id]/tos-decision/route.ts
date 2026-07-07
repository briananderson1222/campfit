/**
 * app/api/admin/aggregators/[id]/tos-decision/route.ts — campfit#93 Wave 3,
 * Task 3.2 (R1/AC1): `POST` records the human ToS-review decision — the
 * literal hard checkpoint AC1 exists to force.
 *
 * Admin-only (no `allowModerator`), unlike the sibling registration/list/
 * detail routes: recording a ToS decision is a stricter, admin-tier action
 * per the plan's explicit framing ("a ToS review decision is an admin-tier
 * action, matching the issue's 'hard human checkpoint' framing more
 * strictly than a routine moderator action").
 */
import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getAggregatorSourceCommunitySlug } from '@/lib/admin/community-access';
import {
  ensureAggregatorSourceSchema,
  getAggregatorSource,
  recordTosDecision,
} from '@/lib/ingestion/aggregator/aggregator-repository';

const VALID_DECISIONS = new Set(['APPROVED', 'DECLINED']);

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const pool = getPool();
  await ensureAggregatorSourceSchema(pool);

  const communitySlug = await getAggregatorSourceCommunitySlug(params.id);
  // Admin-only — intentionally NOT allowModerator: true.
  const auth = await requireAdminAccess({ communitySlug });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const existing = await getAggregatorSource(params.id, pool);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const decision = typeof body.decision === 'string' ? body.decision.trim().toUpperCase() : '';
  if (!VALID_DECISIONS.has(decision)) {
    return NextResponse.json({ error: "decision must be 'APPROVED' or 'DECLINED'" }, { status: 400 });
  }
  const notes = typeof body.notes === 'string' ? body.notes : null;

  const updated = await recordTosDecision(
    params.id,
    { decision: decision as 'APPROVED' | 'DECLINED', reviewedBy: auth.access.email, notes },
    pool,
  );
  return NextResponse.json(updated);
}
