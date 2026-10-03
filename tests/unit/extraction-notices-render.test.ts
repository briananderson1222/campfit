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

  it('lists entries left out of a list, refused values and the programs of a multi-program page', () => {
    const html = render({
      via: 'traverse-recrawl',
      droppedEntries: ['socialLinks: a second instagram link (https://www.instagram.com/pineridgeranch/) was left out; https://www.instagram.com/pineridgecamps/ was kept'],
      refusedValues: { campTypes: ['DAY_CAMP', 'DAY'], schedules: ['2026-12-22'] },
      multiProgram: { names: ['Pine Ridge Junior Camp', 'High Meadow Ranch for Girls'], withheldFields: ['name', 'description'] },
    });
    expect(html).toContain('data-testid="dropped-entry-notices"');
    expect(html).toContain('Entries left out of the proposed lists');
    expect(html).toContain('a second instagram link (https://www.instagram.com/pineridgeranch/) was left out');
    expect(html).toContain('Camp types: the extraction also returned &quot;DAY_CAMP&quot;, &quot;DAY&quot;, which are not valid for this field and are not proposed.');
    expect(html).toContain('This page lists 2 programs (Pine Ridge Junior Camp, High Meadow Ranch for Girls).');
    expect(html).toContain('and neither is description, where the programs differ');
  });

  it('lists a field the page states several values for', () => {
    const html = render({ via: 'traverse-recrawl', conflictingValues: { city: ['Denver', 'Golden'] } });
    expect(html).toContain('data-testid="conflicting-value-notices"');
    expect(html).toContain('Conflicting values on the page');
    expect(html).toContain('City: the page states 2 different values (&quot;Denver&quot;, &quot;Golden&quot;). None is proposed; check the page and edit the field manually if one is right.');
  });

  it('renders nothing for a complete run', () => {
    expect(render({ via: 'traverse-recrawl' })).toBe('');
    expect(render(null)).toBe('');
  });
});
