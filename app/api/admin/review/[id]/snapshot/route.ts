/**
 * GET /api/admin/review/[id]/snapshot — R2/AC2 (campfit#91
 * review-provenance-validation, Wave 1 Task 3): read-only drill-down that
 * resolves a proposal's `snapshotRef` (a `traverse-snapshot:...` sourceRef,
 * see `lib/admin/types.ts`'s `CampChangeProposal.snapshotRef`) back to the
 * exact traverse-fetch snapshot it was extracted from.
 *
 * Auth mirrors the existing approve/reject routes' pattern
 * (`app/api/admin/review/[id]/approve/route.ts`):
 * `getProposalCommunitySlug` -> `requireAdminAccess` -> `getProposal`.
 *
 * NOTE: `snapshotRef` is populated at proposal-creation time by both
 * `runCrawlPipeline` strategies (camp re-crawl and source sweep) —
 * `lib/ingestion/crawl-pipeline.ts`'s two `createProposal(...)` call sites
 * (campfit#97, the write-side fast-follow this note used to point at). A
 * proposal only has `snapshotRef: null` when the underlying traverse fetch
 * never captured a snapshot (e.g. a fetch/extraction failure), not because
 * the value is dropped before persistence. Fixture coverage:
 * `tests/integration/review-snapshot-route.test.ts`; real pipeline-created
 * round-trip coverage: `tests/integration/crawl-pipeline-snapshot-ref-writeside.test.ts`.
 */
import { NextResponse } from 'next/server';

import { parseSnapshotSourceRef } from '@kontourai/traverse/fetch';

import { requireAdminAccess } from '@/lib/admin/access';
import { getProposalCommunitySlug } from '@/lib/admin/community-access';
import { getProposal } from '@/lib/admin/review-repository';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';

/**
 * Hard cap on the number of `body` characters returned in the JSON payload
 * (review-code.md M3: unbounded snapshot body size). 500k chars comfortably
 * covers real-world HTML page bodies while bounding worst-case payload size
 * once the ingestion-lane follow-up starts populating real `snapshotRef`s.
 * The client (`components/admin/snapshot-drilldown.tsx`) surfaces
 * `truncated`/`totalLength` to the reviewer rather than silently dropping
 * data.
 */
const SNAPSHOT_BODY_MAX_CHARS = 500_000;

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const communitySlug = await getProposalCommunitySlug(params.id);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const proposal = await getProposal(params.id);
  // review-code.md M1 (accepted, inherited unchanged from approve/reject):
  // a nonexistent id and an id that exists in a different community are
  // distinguishable (404 here vs. 403 above) — a known, non-blocking
  // existence-oracle signal, not a regression introduced by this route.
  if (!proposal) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (!proposal.snapshotRef) {
    // The honest, expected state for every real proposal today — see the
    // file header note. Not a malfunction.
    return NextResponse.json({ error: 'no_snapshot_ref' }, { status: 404 });
  }

  const parsed = parseSnapshotSourceRef(proposal.snapshotRef);
  if (!parsed) {
    return NextResponse.json({ error: 'malformed_snapshot_ref' }, { status: 404 });
  }

  const store = createCampfitSnapshotStore();
  const snapshot = await store.get(parsed.sourceId, parsed.bodyHash);
  if (!snapshot) {
    return NextResponse.json({ error: 'snapshot_not_found_in_store' }, { status: 404 });
  }

  const totalLength = snapshot.body.length;
  const truncated = totalLength > SNAPSHOT_BODY_MAX_CHARS;
  const body = truncated ? snapshot.body.slice(0, SNAPSHOT_BODY_MAX_CHARS) : snapshot.body;

  return NextResponse.json({
    snapshot: {
      url: snapshot.url,
      fetchedAt: snapshot.fetchedAt,
      bodyHash: snapshot.bodyHash,
      body,
      truncated,
      totalLength,
      // campfit#53 (spa-ingestion, AC3): traverse's own honest,
      // presence-is-the-marker `Snapshot.rendered` field (native
      // rendered-fetch seam, @kontourai/traverse@0.13.0) — `true` only when
      // this snapshot's bytes actually came from a headless-Chromium
      // render, never inferred/guessed. Coalesced to `false` (not left
      // undefined) so the client's rendered-badge check is a plain boolean,
      // matching this route's existing `truncated`-style always-present
      // field convention.
      rendered: snapshot.rendered ?? false,
    },
  });
}
