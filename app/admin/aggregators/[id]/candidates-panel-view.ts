/**
 * app/admin/aggregators/[id]/candidates-panel-view.ts — pure,
 * framework-free helpers for `candidates-panel.tsx` (campfit#93 Wave 4,
 * Task 4.2).
 *
 * Split out from the `'use client'` panel specifically so this logic has a
 * real unit-test surface — this repo has no jsdom/testing-library harness
 * for rendering `'use client'` components with hooks (verified: zero
 * `.test.tsx` files, no `testing-library` dependency; see campfit#96, the
 * standing accepted gap `app/admin/crawls/schedule-panel-view.ts` already
 * documents for the same reason, and the deliver instruction for this task).
 * Every export here is a plain function over plain data — no React import,
 * no hooks — exercised directly by
 * `tests/integration/candidates-panel-view.test.ts`.
 *
 * Route contracts consumed here are declared, not yet built, at the time of
 * this task's execution (`GET/POST /api/admin/aggregators/[id]/candidates*`
 * are Wave 4, Task 4.1's files, owned by a parallel worker) — see this
 * file's shapes (`AggregatorCandidateRow`, `OnboardResultRow`) for the exact
 * contract asserted from the plan
 * (`aggregator-discovery--plan.md`, Wave 4 Tasks 4.1/4.2). Reconciliation:
 * if the shipped route's field names diverge from this shape once merged,
 * only this file + `candidates-panel.tsx`'s fetch/parse call sites need to
 * change — no other UI file depends on the wire shape directly.
 */
import type { ProviderCandidateRow } from '@/lib/ingestion/discovery/candidate-repository';

/** The exact fields the candidates panel reads off a `ProviderCandidateRow`
 * — a view-side `Pick`, not a second/competing type (mirrors
 * `schedule-panel-view.ts`'s own `ScheduleLastRun` precedent of narrowing an
 * existing repository row type down to what one screen needs). */
export type AggregatorCandidateRow = Pick<
  ProviderCandidateRow,
  | 'id'
  | 'name'
  | 'websiteUrl'
  | 'locale'
  | 'possibleDuplicateOfProviderId'
  | 'possibleDuplicateOfName'
  | 'duplicateReason'
  | 'provenanceExcerpt'
  | 'provenanceLocator'
  | 'snapshotSourceRef'
>;

/** Dedupe badge (R3/AC3) — reflects the SAME classify vocabulary
 * `lib/ingestion/discovery/dedupe.ts`'s `classifyCandidate` already applies
 * at enqueue time (`lib/ingestion/aggregator/aggregator-extraction.ts`):
 * `exact-duplicate` candidates are never enqueued at all (skipped before
 * this screen ever sees them), so the only two states a queued candidate
 * can show here are "new" (no `possibleDuplicateOfProviderId`) and
 * "near-duplicate" (one is set) — this function does not re-run
 * `classifyCandidate`, it reads the persisted verdict off the row. */
export function dedupeBadge(
  candidate: Pick<AggregatorCandidateRow, 'possibleDuplicateOfProviderId' | 'possibleDuplicateOfName' | 'duplicateReason'>,
): { label: string; tone: 'new' | 'duplicate'; tooltip: string | null } {
  if (candidate.possibleDuplicateOfProviderId) {
    return {
      label: `Possible duplicate of ${candidate.possibleDuplicateOfName ?? 'an existing provider'}`,
      tone: 'duplicate',
      tooltip: candidate.duplicateReason ?? null,
    };
  }
  return { label: 'New', tone: 'new', tooltip: null };
}

/** Tailwind classes for `dedupeBadge`'s two tones — kept separate from the
 * label/tooltip computation above so the pure classification logic and its
 * visual styling can each be asserted independently. Mirrors
 * `providers-table.tsx`'s pending-proposals pill (amber = needs a look). */
export function dedupeBadgeClassName(tone: 'new' | 'duplicate'): string {
  return tone === 'duplicate'
    ? 'bg-amber-100 text-amber-700'
    : 'bg-pine-100 text-pine-700';
}

/** Provenance excerpt display text (the review-panel excerpt idiom,
 * `provider-review-panel.tsx`'s `diff.excerpt` quote card) — truncated so a
 * long extracted passage doesn't blow out the row layout; never truncates
 * mid-word where avoidable. */
export function truncateExcerpt(excerpt: string | null, maxLength = 180): string | null {
  if (!excerpt) return null;
  if (excerpt.length <= maxLength) return excerpt;
  const cut = excerpt.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Link target for a candidate's source snapshot (`snapshotSourceRef`,
 * the #97 write-side pattern) — `null` when the discovery run recorded no
 * snapshot ref for this candidate (e.g. a pre-#93 curated-source candidate
 * with no aggregator provenance at all), so the panel can omit the link
 * instead of rendering a broken href. */
export function snapshotSourceHref(snapshotSourceRef: string | null): string | null {
  return snapshotSourceRef && snapshotSourceRef.trim().length > 0 ? snapshotSourceRef : null;
}

/** The onboard route's declared per-candidate result shape (Task 4.1's
 * `POST .../candidates/onboard` contract: `{results: [{candidateId, status,
 * providerId?, providerSlug?, providerCreated?, error?}]}`). */
export interface OnboardResultRow {
  candidateId: string;
  status: 'created' | 'existing' | 'error';
  providerId?: string;
  providerSlug?: string;
  providerCreated?: boolean;
  error?: string;
}

/** Per-candidate post-onboard readout (R4/AC4): `created` links straight
 * into the EXISTING unmodified `FirstCrawlOffer` via `?created=1`
 * (`app/admin/providers/[providerId]/first-crawl-offer.tsx`, never edited
 * by this task); `existing` links to the matched provider WITHOUT
 * `?created=1` (matches `provider-new-form.tsx`'s existing-duplicate UX —
 * no first-crawl offer for a provider that already existed before this
 * onboard); `error` renders inline with no link, and the candidate stays
 * selectable for retry (the panel achieves that by simply not removing it
 * from the selectable list — this function only computes the readout, not
 * selection state). */
export function onboardResultCopy(result: OnboardResultRow): { message: string; href: string | null; linkLabel: string | null } {
  if (result.status === 'created' && result.providerId) {
    return {
      message: 'Onboarded — a new Provider was created.',
      href: `/admin/providers/${result.providerId}?created=1`,
      linkLabel: 'View & run first crawl →',
    };
  }
  if (result.status === 'existing' && result.providerId) {
    return {
      message: 'Already onboarded — matched an existing Provider.',
      href: `/admin/providers/${result.providerId}`,
      linkLabel: 'Already onboarded — open it →',
    };
  }
  return {
    message: result.error ?? 'Failed to onboard this candidate.',
    href: null,
    linkLabel: null,
  };
}

// ── Fetch-outcome classification (mirrors schedule-panel-view.ts's
// classifyScheduleLoad — same HIGH-finding-driven discipline: a non-2xx
// or network-rejected response must never be passed to setState as if it
// were ready data). ──────────────────────────────────────────────────────

export type CandidatesFetchOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http-error'; status: number; body: unknown }
  | { kind: 'network-error' };

export type CandidatesLoadResult =
  | { status: 'ready'; candidates: AggregatorCandidateRow[] }
  | { status: 'error'; message: string };

function extractErrorMessage(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.length > 0) return err;
  }
  return null;
}

/** Classifies the panel's initial `GET .../candidates` load. The success
 * body is the bare `AggregatorCandidateRow[]` array per Task 4.1's declared
 * contract (`GET .../candidates?status=PENDING` → candidate rows) — a
 * non-array success body is treated as a malformed response, not a crash. */
export function classifyCandidatesLoad(outcome: CandidatesFetchOutcome): CandidatesLoadResult {
  switch (outcome.kind) {
    case 'network-error':
      return { status: 'error', message: 'Failed to load candidates' };
    case 'http-error':
      return {
        status: 'error',
        message: extractErrorMessage(outcome.body) ?? `Failed to load candidates (status ${outcome.status})`,
      };
    case 'ok':
      return Array.isArray(outcome.body)
        ? { status: 'ready', candidates: outcome.body as AggregatorCandidateRow[] }
        : { status: 'error', message: 'Failed to load candidates (unexpected response shape)' };
  }
}

export type OnboardFetchOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http-error'; status: number; body: unknown }
  | { kind: 'network-error' };

export type OnboardSubmitResult =
  | { status: 'ready'; results: OnboardResultRow[] }
  | { status: 'error'; message: string };

/** Classifies the "Onboard selected" `POST .../candidates/onboard` response
 * (Task 4.1's declared contract: `{results: [...]}`). */
export function classifyOnboardResponse(outcome: OnboardFetchOutcome): OnboardSubmitResult {
  switch (outcome.kind) {
    case 'network-error':
      return { status: 'error', message: 'Failed to onboard selected candidates' };
    case 'http-error':
      return {
        status: 'error',
        message: extractErrorMessage(outcome.body) ?? `Failed to onboard selected candidates (status ${outcome.status})`,
      };
    case 'ok': {
      const results = (outcome.body as { results?: unknown } | null)?.results;
      return Array.isArray(results)
        ? { status: 'ready', results: results as OnboardResultRow[] }
        : { status: 'error', message: 'Failed to onboard selected candidates (unexpected response shape)' };
    }
  }
}
