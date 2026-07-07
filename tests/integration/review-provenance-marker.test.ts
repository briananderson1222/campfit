/**
 * tests/integration/review-provenance-marker.test.ts — AC3
 * (`ac3-no-provenance-marker`, campfit#91 Wave 1 Task 2 / R3) acceptance
 * suite for the review panel's diff-row "no provenance" marker.
 *
 * This repo's Vitest config (`vitest.config.ts`) runs in a plain-Node
 * `environment: "node"` with no `jsdom`/`happy-dom` and no
 * `@testing-library/*` dependency installed, and its `include` glob only
 * picks up `tests/integration/**\/*.test.ts` (not `.test.tsx`). Rendering the
 * full `ReviewPanel` client component directly is additionally impractical
 * here: it calls `next/navigation`'s `useRouter`, which throws outside a
 * real App Router tree. Per the plan's contingency for this exact situation
 * (see Wave 1 Task 1's file note — "if [DOM/RSC rendering] does not
 * [already work], cover via targeted unit tests ... PLUS a snapshot/
 * shallow-render assertion", confirmed instead of silently dropping to
 * logic-only coverage), this file:
 *
 *   1. Unit-tests `hasProvenance` — the exact pure predicate
 *      `review-panel.tsx`'s diff-row now calls to choose between the
 *      existing excerpt/source-link block and the new marker (R3's
 *      else-branch, `review-panel.tsx` lines ~602-614) — against all three
 *      AC3 fixtures.
 *   2. Renders `<FieldProvenanceMarker />` for real via
 *      `react-dom/server`'s `renderToStaticMarkup` (no DOM/jsdom required —
 *      this is server-side string rendering) and asserts the resulting
 *      markup carries the expected marker copy/idiom.
 *
 * Together these prove the exact branch condition driving R3's render
 * decision, and that the marker it renders is the intended one — without
 * requiring a DOM-rendering dependency this repo does not have.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FieldProvenanceMarker, hasProvenance } from '@/components/admin/field-provenance-marker';
import type { FieldDiff } from '@/lib/admin/types';

function fieldDiff(overrides: Partial<FieldDiff>): FieldDiff {
  return { old: null, new: 'some-value', confidence: 0.9, ...overrides };
}

describe('hasProvenance (R3 diff-row predicate)', () => {
  it('(a) is true when both excerpt and sourceUrl are present', () => {
    const diff = fieldDiff({ excerpt: 'Camp is open weekdays 9-5.', sourceUrl: 'https://example.com/camp' });
    expect(hasProvenance(diff)).toBe(true);
  });

  it('(b) is false when neither excerpt nor sourceUrl is present', () => {
    const diff = fieldDiff({ excerpt: undefined, sourceUrl: undefined });
    expect(hasProvenance(diff)).toBe(false);
  });

  it('(c) is true when only sourceUrl is present (no excerpt) — preserves the existing ||-behavior', () => {
    const diff = fieldDiff({ excerpt: undefined, sourceUrl: 'https://example.com/camp' });
    expect(hasProvenance(diff)).toBe(true);
  });

  it('is false when excerpt/sourceUrl are present but empty strings', () => {
    const diff = fieldDiff({ excerpt: '', sourceUrl: '' });
    expect(hasProvenance(diff)).toBe(false);
  });
});

describe('FieldProvenanceMarker', () => {
  it('renders the amber ShieldAlert "no provenance" idiom', () => {
    const html = renderToStaticMarkup(createElement(FieldProvenanceMarker));

    expect(html).toContain('No provenance');
    expect(html).toContain('this field has no excerpt or source link');
    // Reuses the same amber visual idiom as the existing camp-level
    // "no proof citation yet" marker (review-panel.tsx:332-334), not a new
    // ad hoc color/pattern.
    expect(html).toContain('text-amber-400');
    expect(html).toContain('bg-amber-50/60');
  });
});
