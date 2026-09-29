/**
 * The review page's extraction notices, rendered as the page renders them
 * (ExtractionNotices is what `app/admin/review/[id]/page.tsx` mounts).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExtractionNotices } from '@/app/admin/review/[id]/extraction-notices';

const render = (rawExtraction: Record<string, unknown> | null) =>
  renderToStaticMarkup(createElement(ExtractionNotices, { rawExtraction }));

describe('review page extraction notices', () => {
  it('shows a withheld notice for every withheld list and a partial notice for every filled list', () => {
    const html = render({
      via: 'traverse-recrawl',
      incomplete: { reason: 'output-truncated', coverage: [{ status: 'complete' }, { status: 'output-truncated' }] },
      withheldListFields: ['schedules', 'pricing', 'ageGroups'],
      populatedListFields: ['campTypes'],
    });
    expect(html).toContain('Incomplete extraction (output-truncated)');
    for (const label of ['sessions', 'pricing', 'age groups']) {
      expect(html).toContain(`List updates for ${label} were withheld because this run did not read the whole page; re-crawl, or edit manually.`);
    }
    expect(html).toContain('Camp types were filled from a run that did not read the whole page; the list may be missing entries.');
  });

  it('renders nothing for a complete run', () => {
    expect(render({ via: 'traverse-recrawl' })).toBe('');
    expect(render(null)).toBe('');
  });
});
