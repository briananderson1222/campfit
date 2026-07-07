/**
 * app/admin/aggregators/aggregators-view.ts — pure, framework-free
 * formatting/copy helpers for `page.tsx`/`register-form.tsx` (campfit#93
 * Wave 3, Task 3.2).
 *
 * Split out from both the Server Component (`page.tsx`) and the `'use
 * client'` form specifically so this logic has a real unit-test surface —
 * this repo has no jsdom/testing-library harness for rendering `'use
 * client'` components with hooks (verified: zero `.test.tsx` files, no
 * `testing-library` dependency; see campfit#96, the standing accepted gap
 * `app/admin/crawls/schedule-panel-view.ts` already documents for the exact
 * same reason). Every export here is a plain function over plain data — no
 * React import, no hooks — so it is exercised directly by
 * `tests/integration/aggregators-view.test.ts` without that harness.
 */
import type { AggregatorSourceRow } from '@/lib/ingestion/aggregator/types';

/** Visual tone + label for an `AggregatorSource.status` value. Mirrors the
 * badge-pill idiom `app/admin/providers/[providerId]/page.tsx`'s
 * `StatusBadge`/`DataConfidenceBadge` already establish (pine = healthy,
 * amber = attention-needed/in-progress, red = declined/blocked). */
export function statusBadge(status: AggregatorSourceRow['status']): { label: string; className: string } {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', className: 'bg-pine-100 text-pine-700' };
    case 'DECLINED':
      return { label: 'Declined', className: 'bg-red-100 text-red-600' };
    case 'REGISTERED':
    default:
      return { label: 'Registered', className: 'bg-amber-100 text-amber-700' };
  }
}

/** THE ToS-gate readout (R1/AC1) — this is the single most important status
 * on both the list and detail screens, since it is the literal fetch gate:
 * `null` reads as an explicit, attention-grabbing "ToS review required"
 * rather than a passive blank cell, so an admin never mistakes "nobody has
 * reviewed this yet" for "reviewed and fine." */
export function tosGateBadge(tosDecision: AggregatorSourceRow['tosDecision']): { label: string; className: string } {
  switch (tosDecision) {
    case 'APPROVED':
      return { label: 'ToS Approved', className: 'bg-pine-100 text-pine-700' };
    case 'DECLINED':
      return { label: 'ToS Declined', className: 'bg-red-100 text-red-600' };
    case null:
    default:
      return { label: 'ToS review required', className: 'bg-amber-100 text-amber-700 animate-pulse' };
  }
}

/** `true` only when a human has recorded `tosDecision = 'APPROVED'` — the
 * exact same predicate `lib/ingestion/aggregator/aggregator-repository.ts`'s
 * `canFetchAggregator` uses server-side. Re-derived here (not imported) so
 * this stays a pure, dependency-free view helper; the UI-side check is
 * defense-in-depth only, never the actual gate (both the repository layer
 * and the discover route re-check the real row — see that file's header
 * doc). */
export function isTosApproved(tosDecision: AggregatorSourceRow['tosDecision']): boolean {
  return tosDecision === 'APPROVED';
}

/** Short relative-age readout — mirrors `providers-table.tsx`'s own
 * `relativeDate` verbatim (kept as a separate copy here rather than a shared
 * import: that function is a private, unexported helper in a `'use client'`
 * file, not a reusable module). Accepts `Date | string` because this page
 * reads `AggregatorSourceRow.createdAt` (typed `Date`, the `pg` driver's raw
 * `timestamptz` parse) directly server-side, unlike `providers-table.tsx`'s
 * own copy which only ever sees a JSON-serialized ISO string. */
export function relativeDate(dateStr: Date | string | null | undefined): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}yr ago`;
}

/** Register-form submission body shape — kept here (not inline in the
 * client component) so `buildRegisterPayload`'s trimming/defaulting rules
 * have their own direct unit test, matching `provider-new-form.tsx`'s own
 * inline `.trim() || null` conventions applied consistently in one place. */
export interface RegisterAggregatorFormState {
  name: string;
  url: string;
  communitySlug: string;
  maxPages: string;
  maxDepth: string;
}

export interface RegisterAggregatorPayload {
  name: string;
  url: string;
  communitySlug: string;
  maxPages: number;
  maxDepth: number;
}

/** Default field values for a fresh (collapsed→expanded) register form. */
export function emptyRegisterFormState(defaultCommunitySlug: string): RegisterAggregatorFormState {
  return { name: '', url: '', communitySlug: defaultCommunitySlug, maxPages: '20', maxDepth: '2' };
}

/** `true` only once name + a valid http(s) url are present — mirrors
 * `provider-new-form.tsx`'s `canSubmit` shape (name present + URL fields
 * valid via the shared `isValidHttpUrl`). `isUrlValid` is injected rather
 * than imported so this module stays framework/import-light and testable
 * with plain strings; callers pass `isValidHttpUrl` from
 * `lib/admin/onboarding-validation.ts` (unmodified, reused as-is). */
export function canSubmitRegisterForm(
  form: RegisterAggregatorFormState,
  isUrlValid: (value: string) => boolean,
): boolean {
  return Boolean(form.name.trim()) && Boolean(form.url.trim()) && isUrlValid(form.url.trim());
}

/** Builds the exact `POST /api/admin/aggregators` request body (Task 3.2's
 * declared route contract: `{name, url, communitySlug, maxPages, maxDepth}`)
 * — trims strings, falls back to the community default, and clamps
 * maxPages/maxDepth to a sane positive integer (falling back to the
 * repository's own defaults of 20/2, `aggregator-repository.ts`'s
 * `createAggregatorSource`, if the field is blank/non-numeric). */
export function buildRegisterPayload(
  form: RegisterAggregatorFormState,
  defaultCommunitySlug: string,
): RegisterAggregatorPayload {
  const maxPages = Number.parseInt(form.maxPages, 10);
  const maxDepth = Number.parseInt(form.maxDepth, 10);
  return {
    name: form.name.trim(),
    url: form.url.trim(),
    communitySlug: form.communitySlug.trim() || defaultCommunitySlug,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 20,
    maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 2,
  };
}
