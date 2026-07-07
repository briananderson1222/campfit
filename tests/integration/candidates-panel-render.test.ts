/**
 * tests/integration/candidates-panel-render.test.ts — direct
 * `renderToStaticMarkup` coverage for `candidates-panel.tsx`'s initial
 * render (campfit#93 Wave 4, Task 4.2).
 *
 * Unlike `register-form.tsx`/`tos-decision-form.tsx`/
 * `run-discovery-button.tsx`, `CandidatesPanel` never calls `useRouter()` —
 * only `useState`/`useCallback`/`useEffect` — so it can be invoked and
 * rendered directly without mocking Next's App Router context. Its
 * `useEffect` (the `GET .../candidates` fetch-on-mount) never fires during
 * a static server render (effects only run post-hydration), so this test
 * only ever observes the component's initial `'loading'` state — genuine
 * coverage of that render path, not the interactive fetch/select/onboard
 * behavior, which remains the standing campfit#96 accepted gap (recorded,
 * not faked, in `tests/browser/aggregator-curation.spec.ts`).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CandidatesPanel } from '@/app/admin/aggregators/[id]/candidates-panel';

describe('CandidatesPanel — initial static render', () => {
  it('renders the loading state (no fetch fires during a static render)', () => {
    const html = renderToStaticMarkup(createElement(CandidatesPanel, { aggregatorId: 'agg-1' }));
    expect(html).toContain('Loading candidates');
    expect(html).toContain('glass-panel');
  });
});
