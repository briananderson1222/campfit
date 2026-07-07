/**
 * tests/integration/review-format-badge.test.ts — AC1 (`ac1-format-badge`,
 * campfit#91 Wave 1 Task 1 / R1) acceptance suite for the review panel's
 * per-field format-validity badge.
 *
 * This repo's Vitest config (`vitest.config.ts`) runs in a plain-Node
 * `environment: "node"` with no `jsdom`/`happy-dom` and no
 * `@testing-library/*` dependency installed, and its `include` glob only
 * picks up `tests/integration/**\/*.test.ts` (not `.test.tsx`) — confirmed by
 * probing `npx vitest run` against a scratch `.test.tsx` file, which reported
 * "No test files found". Rendering the full `ReviewPanel` client component
 * directly is additionally impractical: it calls `next/navigation`'s
 * `useRouter`, which throws outside a real App Router tree. Per the plan's
 * contingency for this exact situation (Wave 1 Task 1's file note — "if [DOM/
 * RSC rendering] does not [already work], cover via targeted unit tests ...
 * PLUS a snapshot/shallow-render assertion", confirmed instead of silently
 * dropping to logic-only coverage), this file:
 *
 *   1. Unit-tests `checkFieldFormat` — the exact pure function
 *      `review-panel.tsx`'s diff-row now calls to choose the badge state
 *      (`review-panel.tsx` line ~548) — against all seven AC1 fixtures
 *      (valid scalar, invalid scalar, invalid enum, valid/invalid
 *      enum-array, uncheckable schema-absent field, uncheckable empty
 *      value).
 *   2. Renders `<FieldFormatBadge />` for real via `react-dom/server`'s
 *      `renderToStaticMarkup` (no DOM/jsdom required — this is server-side
 *      string rendering) for each of its three visual states and asserts the
 *      resulting markup carries the expected label/styling per state.
 *
 * Together these prove both the format-conformance logic against the
 * pipeline's own schema (`lib/ingestion/traverse-schema.ts`, read-only import)
 * and that the badge renders the intended visual state for each — without
 * requiring a DOM-rendering dependency this repo does not have.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { checkFieldFormat } from '@/lib/admin/review-format-validation';
import { FieldFormatBadge } from '@/components/admin/field-format-badge';

describe('checkFieldFormat (R1 per-field format check)', () => {
  it('(a) valid scalar — city: "Denver" against the string schema entry', () => {
    expect(checkFieldFormat('city', 'Denver')).toBe('valid');
  });

  it('(b) invalid scalar — lunchIncluded: "yes" (string) against the boolean schema entry', () => {
    expect(checkFieldFormat('lunchIncluded', 'yes')).toBe('invalid');
  });

  it('(c) invalid enum — category: "NOT_A_REAL_CATEGORY" against CampCategory enumValues', () => {
    expect(checkFieldFormat('category', 'NOT_A_REAL_CATEGORY')).toBe('invalid');
  });

  it('(d) valid enum-array — campTypes: ["SUMMER_DAY"]', () => {
    expect(checkFieldFormat('campTypes', ['SUMMER_DAY'])).toBe('valid');
  });

  it('(e) invalid enum-array — categories: ["NOPE"]', () => {
    expect(checkFieldFormat('categories', ['NOPE'])).toBe('invalid');
  });

  it('(f) uncheckable schema-absent field — notes: "some note" (camp-record-only field, no CAMP_TARGET_SCHEMA entry)', () => {
    expect(checkFieldFormat('notes', 'some note')).toBe('uncheckable');
  });

  it('(g) uncheckable empty/null value — websiteUrl: null', () => {
    expect(checkFieldFormat('websiteUrl', null)).toBe('uncheckable');
  });

  it('is uncheckable for an empty string (nothing to check, same as null)', () => {
    expect(checkFieldFormat('city', '')).toBe('uncheckable');
  });

  it('is uncheckable for a row-array family field (ageGroups) — no per-field schema path for it', () => {
    expect(checkFieldFormat('ageGroups', [{ minAge: 5, maxAge: 9 }])).toBe('uncheckable');
  });

  it('is valid for a correctly-typed date scalar (registrationOpenDate)', () => {
    expect(checkFieldFormat('registrationOpenDate', '2026-06-01')).toBe('valid');
  });

  it('is invalid for a malformed date scalar (not ISO YYYY-MM-DD-prefixed)', () => {
    expect(checkFieldFormat('registrationOpenDate', 'June 1, 2026')).toBe('invalid');
  });

  it('is invalid for a non-array value on an enum-array field', () => {
    expect(checkFieldFormat('campTypes', 'SUMMER_DAY')).toBe('invalid');
  });
});

describe('FieldFormatBadge (three visual states)', () => {
  it('renders the "valid" state with the pine/green idiom', () => {
    const html = renderToStaticMarkup(createElement(FieldFormatBadge, { state: 'valid' }));
    expect(html).toContain('Valid format');
    expect(html).toContain('bg-pine-100');
    expect(html).toContain('text-pine-600');
  });

  it('renders the "invalid" state with the red idiom', () => {
    const html = renderToStaticMarkup(createElement(FieldFormatBadge, { state: 'invalid' }));
    expect(html).toContain('Invalid format');
    expect(html).toContain('bg-red-100');
    expect(html).toContain('text-red-500');
  });

  it('renders the "uncheckable" state with the neutral/gray idiom', () => {
    const html = renderToStaticMarkup(createElement(FieldFormatBadge, { state: 'uncheckable' }));
    expect(html).toContain('Format not checkable');
    expect(html).toContain('bg-cream-200');
    expect(html).toContain('text-bark-400');
  });
});
