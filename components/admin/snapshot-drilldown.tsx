/**
 * components/admin/snapshot-drilldown.tsx — R2/AC2 panel half (campfit#91
 * review-provenance-validation, Wave 2 Task 4): the proposal-level "View
 * source snapshot" affordance in `review-panel.tsx`'s Source sidebar block
 * (lines ~699-728). Fires `GET /api/admin/review/[id]/snapshot` when the
 * proposal carries a `snapshotRef` and renders the resolved snapshot's
 * `url`/`fetchedAt`/body in an expandable panel, reusing the same
 * `AdminSourceLink` idiom as the existing excerpt block.
 *
 * This is a proposal-level affordance, distinct from R3's per-FIELD
 * `FieldProvenanceMarker` (which fires on a missing `diff.excerpt`/
 * `diff.sourceUrl` for one field). This component fires on a missing
 * `proposal.snapshotRef` for the whole proposal and renders nothing in that
 * case — see the plan's Task 4 Context note not to conflate the two.
 *
 * Split into its own file (rather than inlined in `review-panel.tsx`) for
 * the same reason Wave 1's `field-format-badge.tsx`/
 * `field-provenance-marker.tsx` were: `review-panel.tsx`'s top-level
 * `ReviewPanel` calls `next/navigation`'s `useRouter`, which throws when
 * rendered outside a real App Router tree — this repo's plain-Node Vitest
 * environment (no jsdom/testing-library) can't render it directly. This
 * component owns no router dependency, so it (and its exported
 * `parseSnapshotResponse` helper) can be exercised directly in tests.
 */
'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, FileText, Loader2, MonitorPlay } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCampDateTime } from '@/lib/date-format';
import { displayExternalUrl, safeExternalHref } from '@/lib/admin/safe-url';

/** Shape of a resolved snapshot, mirroring the route's `200` JSON body. */
export interface ResolvedSnapshot {
  url: string;
  fetchedAt: string;
  bodyHash: string;
  body: string;
  /** True when the route truncated `body` server-side (review-code.md M3). */
  truncated: boolean;
  /** The snapshot's real, untruncated body length, regardless of `truncated`. */
  totalLength: number;
  /**
   * campfit#53 (spa-ingestion, AC3): traverse's own honest `Snapshot.rendered`
   * marker — true only when this snapshot's bytes came from a
   * headless-Chromium render, never a plain fetch. Drives the "Rendered"
   * badge below; both the true AND false/absent cases have explicit test
   * coverage (a badge that always/never renders would fail AC3's honesty
   * requirement — see the plan's stop-short risk).
   */
  rendered?: boolean;
}

export type SnapshotDrilldownState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; snapshot: ResolvedSnapshot };

const BODY_PREVIEW_LENGTH = 2000;

/**
 * Parses the `GET /api/admin/review/[id]/snapshot` route's `Response` into
 * this component's state shape. Pure aside from consuming `res.json()`, and
 * exported so it can be exercised directly against a REAL `Response`
 * produced by the route's own exported `GET` handler in tests — the exact
 * function this component's click handler calls after `fetch()` resolves,
 * without needing a DOM/jsdom environment to prove it.
 */
export async function parseSnapshotResponse(res: Response): Promise<SnapshotDrilldownState> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body && typeof body.error === 'string' && body.error.trim()
      ? body.error
      : 'Failed to load source snapshot';
    return { status: 'error', message };
  }
  if (!body || typeof body.snapshot !== 'object' || body.snapshot === null) {
    return { status: 'error', message: 'Malformed snapshot response' };
  }
  return { status: 'loaded', snapshot: body.snapshot as ResolvedSnapshot };
}

export function SnapshotDrilldown({
  proposalId,
  snapshotRef,
}: {
  proposalId: string;
  snapshotRef?: string | null;
}) {
  const [state, setState] = useState<SnapshotDrilldownState>({ status: 'idle' });
  const [bodyExpanded, setBodyExpanded] = useState(false);

  // Proposal-level affordance: absent for every real proposal today until
  // the ingestion-lane follow-up populates `snapshotRef` (see the route's
  // file header). Honest nothing-renders, not an error state.
  if (!snapshotRef) return null;

  const isLoaded = state.status === 'loaded';

  const toggle = async () => {
    if (isLoaded) {
      setState({ status: 'idle' });
      setBodyExpanded(false);
      return;
    }
    setState({ status: 'loading' });
    try {
      const res = await fetch(`/api/admin/review/${proposalId}/snapshot`);
      setState(await parseSnapshotResponse(res));
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load source snapshot' });
    }
  };

  return (
    <div className="border-t border-cream-300 pt-3 dark:border-[var(--admin-border)]" data-testid="snapshot-drilldown">
      <button
        onClick={toggle}
        disabled={state.status === 'loading'}
        className="flex items-center gap-1.5 text-xs text-pine-500 hover:text-pine-700 disabled:opacity-50"
        data-testid="snapshot-drilldown-toggle"
      >
        {state.status === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
        {isLoaded ? 'Hide source snapshot' : 'View source snapshot'}
        {isLoaded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {state.status === 'error' && (
        <p className="mt-1.5 text-xs text-red-500" data-testid="snapshot-drilldown-error">{state.message}</p>
      )}

      {isLoaded && (
        <div className="mt-2 rounded-lg bg-pine-50/60 border border-pine-200/50 px-2.5 py-2 space-y-1.5 admin-surface" data-testid="snapshot-drilldown-panel">
          <SnapshotSourceLink url={state.snapshot.url} />
          <p className="text-[11px] text-bark-300">Fetched {formatCampDateTime(state.snapshot.fetchedAt)}</p>
          {shouldShowRenderedBadge(state.snapshot) && (
            <p className="flex items-center gap-1 text-[11px] text-pine-600" data-testid="snapshot-drilldown-rendered-badge">
              <MonitorPlay className="w-3 h-3" />
              Rendered (headless browser)
            </p>
          )}
          {formatSnapshotTruncationNotice(state.snapshot) && (
            <p className="text-[11px] text-amber-600" data-testid="snapshot-drilldown-truncated">
              {formatSnapshotTruncationNotice(state.snapshot)}
            </p>
          )}
          <p className={cn('text-xs text-bark-500 italic leading-relaxed whitespace-pre-wrap', !bodyExpanded && 'max-h-40 overflow-hidden')}>
            {bodyExpanded ? state.snapshot.body : state.snapshot.body.slice(0, BODY_PREVIEW_LENGTH)}
            {!bodyExpanded && state.snapshot.body.length > BODY_PREVIEW_LENGTH && '…'}
          </p>
          {state.snapshot.body.length > BODY_PREVIEW_LENGTH && (
            <button
              onClick={() => setBodyExpanded((v) => !v)}
              className="flex items-center gap-1 text-xs text-bark-300 hover:text-bark-500"
            >
              {bodyExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {bodyExpanded ? 'Collapse' : 'Expand full snapshot'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Formats the route's server-side truncation signal (review-code.md M3) into
 * a reviewer-facing notice, or `null` when the route returned the full body.
 * Exported (not inlined in `SnapshotDrilldown`) so the message text itself is
 * directly unit-testable without a DOM/jsdom environment, same reasoning as
 * `parseSnapshotResponse`.
 */
export function formatSnapshotTruncationNotice(snapshot: ResolvedSnapshot): string | null {
  if (!snapshot.truncated) return null;
  return `Truncated (showing ${snapshot.body.length.toLocaleString('en-US')} of ${snapshot.totalLength.toLocaleString('en-US')} characters)`;
}

/**
 * Whether the "Rendered (headless browser)" badge should show for this
 * resolved snapshot (campfit#53 spa-ingestion, AC3). Extracted as its own
 * pure, exported predicate — same reasoning as
 * {@link formatSnapshotTruncationNotice} above — so BOTH the true and
 * false/absent cases are directly unit-testable without a DOM/jsdom
 * environment (this repo's Vitest config has neither): a badge that always
 * or never shows would technically "add a badge" while failing AC3's
 * honesty requirement, so this predicate (not just the JSX it feeds) is the
 * regression-proof surface.
 */
export function shouldShowRenderedBadge(snapshot: ResolvedSnapshot): boolean {
  return snapshot.rendered === true;
}

/**
 * Minimal local rendering of the same "external link" idiom
 * `review-panel.tsx`'s private `AdminSourceLink` uses (icon + truncated
 * label + pine-500 hover pine-700, falling back to plain text for an unsafe
 * `url`). Reimplemented locally (rather than importing the private helper
 * from `review-panel.tsx`) to avoid a component<->component circular import
 * between this file and `review-panel.tsx` (which imports
 * `SnapshotDrilldown` from here) — both build on the same exported
 * `lib/admin/safe-url.ts` utilities, so the visual result matches exactly.
 */
function SnapshotSourceLink({ url }: { url: string }) {
  const safeHref = safeExternalHref(url);
  const content = (
    <>
      <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      {displayExternalUrl(url, 70)}
    </>
  );

  if (!safeHref) {
    return (
      <span className="inline-flex items-center gap-1 break-all text-bark-400 text-xs">
        {content}
      </span>
    );
  }

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 break-all text-pine-500 hover:text-pine-700 text-xs"
    >
      {content}
    </a>
  );
}
