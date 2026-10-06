/**
 * A session date whose own line states no year may take its year from one
 * other excerpt on the page, which is shown to the reviewer beside the
 * session (owner decision). No guessing: when no excerpt settles the year,
 * the date is refused as before.
 *
 * The extractions run through the real Relay extraction provider and the real
 * content preparation; only the model runtime replays a written answer.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractionProposal } from '@kontourai/traverse';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { runTraverseExtraction } from '@/lib/ingestion/traverse-extractor';
import { assembleItems } from '@/lib/ingestion/traverse-item-grouping';
import { assembledItemToDiffInputs } from '@/lib/ingestion/traverse-diff-inputs';
import { preparedTextOf } from '@/lib/ingestion/prepared-text';
import { excerptStatesOnlyYearOf, yearsStatedIn } from '@/lib/ingestion/session-year';
import { RowCitations } from '@/app/admin/review/[id]/row-citations';
import { createReplayProvider } from '../fixtures/real-crawl/replay';

const W1 = 'Week 1: June 14 - June 18';
const W2 = 'Week 2: June 21 - June 25';

/** `## text` is a heading; anything else a paragraph. */
function page(blocks: readonly string[]): string {
  const html = blocks.map((block) => {
    const heading = /^(#{1,6}) (.*)$/.exec(block);
    return heading ? `<h${heading[1]!.length}>${heading[2]}</h${heading[1]!.length}>` : `<p>${block}</p>`;
  }).join('');
  return `<html><body><main><h1>Larkspur Meadow Day Camp</h1>${html}</main></body></html>`;
}

function answer(fieldPath: string, value: unknown, excerpt: string) {
  return { fieldPath, value, excerpt, locator: 'items[0]', occurrenceHint: 1 };
}

function session(start: string, end: string, excerpt: string) {
  return [answer('items[].schedules[].startDate', start, excerpt), answer('items[].schedules[].endDate', end, excerpt)];
}

async function extract(blocks: readonly string[], proposals: readonly unknown[], options: { withoutPageText?: boolean } = {}) {
  const { provider } = createReplayProvider([answer('items[].name', 'Larkspur Meadow Day Camp', 'Larkspur Meadow Day Camp'), ...proposals]);
  const result = await runTraverseExtraction({ content: page(blocks), sourceRef: 'https://larkspur.example.test/summer', provider });
  expect(result.error).toBeUndefined();
  const preparedText = preparedTextOf(result);
  expect(preparedText).toBeDefined();
  const items = assembleItems(result.proposals as ExtractionProposal[], { preparedText: options.withoutPageText ? undefined : preparedText });
  expect(items).toHaveLength(1);
  return { item: items[0]!, preparedText: preparedText! };
}

function yearNote(item: { operatorWarnings: string[] }): string {
  return item.operatorWarnings.find((warning) => warning.includes('not given a year from another excerpt')) ?? '';
}

describe('reading the years a text states', () => {
  it('reads four-digit years and short ranges, not prices or ISO date parts', () => {
    expect([...yearsStatedIn('2027 Camp Dates')]).toEqual([2027]);
    expect([...yearsStatedIn('2026-27 Winter Camp')].sort()).toEqual([2026, 2027]);
    expect([...yearsStatedIn('2026–2027 school year')].sort()).toEqual([2026, 2027]);
    expect([...yearsStatedIn('Starts 2027-06-14')]).toEqual([2027]);
    expect([...yearsStatedIn('6/14/2027')]).toEqual([2027]);
    expect([...yearsStatedIn('Tuition $2027 per session')]).toEqual([]);
    expect([...yearsStatedIn('Week 1: June 14 - June 18')]).toEqual([]);
  });

  it('a year excerpt counts at review only when it states exactly the dates\' one year', () => {
    expect(excerptStatesOnlyYearOf('## 2027 Camp Dates', ['2027-06-14', '2027-06-18'])).toBe(true);
    expect(excerptStatesOnlyYearOf('## 2027 Camp Dates', ['2027-06-14', null])).toBe(true);
    expect(excerptStatesOnlyYearOf('## 2026 Camp Dates', ['2027-06-14', '2027-06-18'])).toBe(false);
    expect(excerptStatesOnlyYearOf('2026 and 2027 Camp Dates', ['2027-06-14', '2027-06-18'])).toBe(false);
    expect(excerptStatesOnlyYearOf('## 2027 Camp Dates', ['2026-12-28', '2027-01-03'])).toBe(false);
    expect(excerptStatesOnlyYearOf('## Camp Dates', ['2027-06-14'])).toBe(false);
  });
});

describe('a session date with no year on its own line', () => {
  it('is refused when no excerpt is used (baseline: the page has a year only in its heading, and no page text)', async () => {
    const { item } = await extract(['## 2027 Camp Dates', W1, W2], [...session('2027-06-14', '2027-06-18', W1), ...session('2027-06-21', '2027-06-25', W2)], { withoutPageText: true });
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('page text it was read from is not available');
  });

  it('takes its year from the heading that directly governs the session lines, cited with an exact locator', async () => {
    const { item, preparedText } = await extract(
      ['## Our 2026 season in photos', 'Thanks to everyone who came in 2026.', '## 2027 Camp Dates', W1, W2, '## Contact', '© 2026 Larkspur Meadow'],
      [...session('2027-06-14', '2027-06-18', W1), ...session('2027-06-21', '2027-06-25', W2)],
    );
    expect(item.schedules.map((s) => [s.label, s.startDate, s.endDate, s.yearCitation?.excerpt])).toEqual([
      [W1, '2027-06-14', '2027-06-18', '## 2027 Camp Dates'],
      [W2, '2027-06-21', '2027-06-25', '## 2027 Camp Dates'],
    ]);
    const locator = /^chars:(\d+)-(\d+)$/.exec(item.schedules[0]!.yearCitation!.locator)!;
    expect(preparedText.slice(Number(locator[1]), Number(locator[2]))).toBe('## 2027 Camp Dates');

    const inputs = assembledItemToDiffInputs(item);
    expect(inputs.rowCitations.schedules?.map((c) => [c.excerpt, c.year?.excerpt])).toEqual([[W1, '## 2027 Camp Dates'], [W2, '## 2027 Camp Dates']]);
    expect(inputs.rowCitations.schedules?.[0]?.year?.locator).toBe(item.schedules[0]!.yearCitation!.locator);
  });

  it('keeps today\'s behaviour when its own cited text states the year: no year excerpt', async () => {
    const own = 'Week 1: June 14 - June 18, 2027';
    const { item } = await extract(['## 2027 Camp Dates', own], session('2027-06-14', '2027-06-18', own));
    expect(item.schedules.map((s) => [s.startDate, s.yearCitation])).toEqual([['2027-06-14', undefined]]);
    expect(assembledItemToDiffInputs(item).rowCitations.schedules?.[0]?.year).toBeUndefined();
  });

  it('is refused when its own line states a year its narrow citation leaves out', async () => {
    const line = 'Week 1: June 14 - June 18 (2026 dates; 2027 to be announced)';
    const { item } = await extract(['## 2027 Camp Dates', line], session('2027-06-14', '2027-06-18', 'Week 1: June 14 - June 18'));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('its own line states 2026, 2027');
  });

  it('is refused when the year the model gave is not the heading\'s year', async () => {
    const { item } = await extract(['## 2027 Camp Dates', W1], session('2026-06-14', '2026-06-18', W1));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('its year (2026) is not the year the heading over it states (2027)');
  });

  it('a page with two governed lists gives each session its own heading\'s year', async () => {
    const old = 'Week 1: June 15 - June 19';
    const { item } = await extract(['## 2026 Sessions', old, '## 2027 Sessions', W1],
      [...session('2026-06-15', '2026-06-19', old), ...session('2027-06-14', '2027-06-18', W1)]);
    expect(item.schedules.map((s) => [s.startDate, s.yearCitation?.excerpt])).toEqual([['2026-06-15', '## 2026 Sessions'], ['2027-06-14', '## 2027 Sessions']]);
  });
});

describe('a citation the model stretched up to a heading', () => {
  it('is not the date\'s own text: the heading becomes the year excerpt, shown to the reviewer', async () => {
    const stretched = `## 2027 Camp Dates\n\n${W1}\n\n${W2}`;
    const { item, preparedText } = await extract(['## 2027 Camp Dates', W1, W2],
      [...session('2027-06-14', '2027-06-18', `## 2027 Camp Dates\n\n${W1}`), ...session('2027-06-21', '2027-06-25', stretched)]);
    expect(preparedText).toContain(stretched);
    expect(item.schedules.map((s) => [s.startDate, s.yearCitation?.excerpt])).toEqual([['2027-06-14', '## 2027 Camp Dates'], ['2027-06-21', '## 2027 Camp Dates']]);
  });

  it('across two sections does not take the year of the heading it starts from', async () => {
    const old = 'Week 1: June 15 - June 19';
    const across = `## 2027 Sessions\n\n${W1}\n\n## 2026 Sessions\n\n${old}`;
    const { item, preparedText } = await extract(['## 2027 Sessions', W1, '## 2026 Sessions', old], session('2027-06-15', '2027-06-19', across));
    expect(preparedText).toContain(across);
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('its cited text runs past the heading "## 2026 Sessions"');
  });

  it('a one-line citation keeps today\'s rule: the year in it is enough', async () => {
    const narrow = 'Week 1: Nature 2027';
    const { item } = await extract([`${narrow} June 14-18`], session('2027-06-14', '2027-06-18', narrow));
    expect(item.schedules.map((s) => [s.startDate, s.yearCitation])).toEqual([['2027-06-14', undefined]]);
  });
});

describe('two or more years that could apply', () => {
  it('a page stating two years, with no year in the heading over the sessions, is refused', async () => {
    const { item } = await extract(
      ['Last year (2026) every week filled up.', 'Registration for 2027 opens in January.', '## Sessions', W1, W2],
      [...session('2027-06-14', '2027-06-18', W1), ...session('2027-06-21', '2027-06-25', W2)],
    );
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('the page states 2 different years (2026, 2027) and the heading over it states none');
  });

  it('the page\'s only year, on a line above the session that states no date, is used', async () => {
    const { item } = await extract(
      ['Summer 2027 at the meadow.', '## Sessions', W1],
      session('2027-06-14', '2027-06-18', W1),
    );
    expect(item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['Summer 2027 at the meadow.']);
  });

  it('a heading stating two years ("2026-27") is refused', async () => {
    const line = 'Winter week: January 4 - January 8';
    const { item } = await extract(['## 2026-27 Winter Camp', line], session('2027-01-04', '2027-01-08', line));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('states more than one year (2026, 2027)');
  });

  it('a governing heading whose section states another year is refused', async () => {
    const { item } = await extract(['## 2027 Camp Dates', W1, 'Same weeks as 2026.'], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('the text under that heading also states 2026');
  });
});

describe('the nearest heading only', () => {
  const PAGE = ['## 2027 Camp Dates', W1, '## Last summer', 'Week 1: June 15 - June 19', '## Contact', 'Founded in 2019.'];
  const LAST = 'Week 1: June 15 - June 19';

  it('a session under another heading (no year) does not take the year of a heading further up', async () => {
    const { item } = await extract(PAGE, [...session('2027-06-14', '2027-06-18', W1), ...session('2027-06-15', '2027-06-19', LAST)]);
    // The second session is refused, so the whole list is withheld.
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain(`"${LAST}": the page states 2 different years (2019, 2027) and the heading over it states none`);
  });

  it('control: the session directly under the year heading is accepted on the same page', async () => {
    const { item } = await extract(PAGE, session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['## 2027 Camp Dates']);
  });

  it('a heading between the year heading and the session (a sub-heading with no year) breaks it', async () => {
    const { item } = await extract(['## 2027 Camp Dates', '### Teen weeks', W1, 'Founded in 2019.'], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('the page states 2 different years (2019, 2027) and the heading over it states none');
  });
});

describe('a range across a year boundary', () => {
  const LINE = 'Winter week: December 28 - January 3';

  it('is refused when the model assigns each date a year', async () => {
    const { item } = await extract(['## 2026 Winter Break Camp', LINE], session('2026-12-28', '2027-01-03', LINE));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('runs across a year boundary (2026, 2027)');
  });

  it('is refused when the model assigns both dates the heading\'s year', async () => {
    const { item } = await extract(['## 2026 Winter Break Camp', LINE], session('2026-12-28', '2026-01-03', LINE));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('its end date (2026-01-03) is before its start date (2026-12-28)');
  });

  it('keeps today\'s behaviour when both years are stated on its own line', async () => {
    const both = 'Winter week: December 28, 2026 - January 3, 2027';
    const { item } = await extract(['## Winter Break Camp', both], session('2026-12-28', '2027-01-03', both));
    expect(item.schedules.map((s) => [s.startDate, s.endDate, s.yearCitation])).toEqual([['2026-12-28', '2027-01-03', undefined]]);
  });
});

describe('the review page', () => {
  it('shows the year excerpt beside the session, apart from its dates\' own text', () => {
    const html = renderToStaticMarkup(createElement(RowCitations, { proposedChanges: {
      schedules: { old: [], new: [{ label: 'Week 1', startDate: '2027-06-14', endDate: '2027-06-18' }, { label: 'Week 2', startDate: '2027-06-21', endDate: '2027-06-25' }],
        rowCitations: [{ excerpt: W1, year: { excerpt: '## 2027 Camp Dates', locator: 'chars:10-28' } }, { excerpt: 'Week 2: June 21 - June 25, 2027' }] },
    } }));
    expect(html.match(/data-testid="row-year-citation"/g)).toHaveLength(1);
    expect(html).toContain(`<q class="break-words text-xs text-bark-500">${W1}</q><span data-testid="row-year-citation"`);
    expect(html).toContain('<strong>Year from:</strong> <q class="break-words">## 2027 Camp Dates</q>');
  });
});

describe('a number that is not a year (fix round 1)', () => {
  // Each line states 2027 as a phone number, a street number, an amount, a
  // URL path or a room label. None may become the year excerpt, by either
  // rule, and none passes the review-apply check.
  const NOT_YEARS = [
    'Call us at 303-555-2027',
    'Tuition: 2027 per week',
    '[Photos](https://larkspur.example.test/2027/summer)',
    'Meet in Room 2027',
  ];

  for (const line of NOT_YEARS) {
    it(`"${line}" is not the page's only year (rule 2)`, async () => {
      const block = line.startsWith('[') ? '<a href="https://larkspur.example.test/2027/summer">Photos</a>' : line;
      const { item, preparedText } = await extract([block, '## Sessions', W1], session('2027-06-14', '2027-06-18', W1));
      expect(preparedText).toContain(line);
      expect(item.schedules).toEqual([]);
    });
    it(`"${line}" fails the review-apply check`, () => {
      expect(excerptStatesOnlyYearOf(line, ['2027-06-14', '2027-06-18'])).toBe(false);
    });
  }

  it('a heading with a street number is not a year heading (rule 1)', async () => {
    const { item } = await extract(['## Lakeside Camp, 2027 Pine Street', W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
    expect(excerptStatesOnlyYearOf('## Lakeside Camp, 2027 Pine Street', ['2027-06-14'])).toBe(false);
  });

  it('a real year line is still found above a phone number line (rule 2)', async () => {
    const { item } = await extract(['Summer 2027 at the meadow.', 'Call us at 303-555-2027', '## Sessions', W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['Summer 2027 at the meadow.']);
  });

  it('a phone number stating another year still makes the page state two years (fail closed)', async () => {
    const { item } = await extract(['Summer 2027 at the meadow.', 'Call us at 303-555-2026', '## Sessions', W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
  });

  it('reads years in the usual places', () => {
    for (const text of ['2027 Camp Dates', 'Summer 2027', 'Summer 2027 at the meadow.', '(2027)', 'June 14, 2027', '6/14/2027', '**2027 SUMMER DAY CAMP**', '## 2027 Camp Dates']) {
      expect(excerptStatesOnlyYearOf(text, ['2027-06-14']), text).toBe(true);
    }
  });
});

describe('a year on the session\'s own label line (fix round 2)', () => {
  it('"Summer 2027 Session 1" above its dates keeps today\'s behaviour, with another year on the page', async () => {
    const cited = 'Summer 2027 Session 1\n\nJune 14 - 18';
    const { item, preparedText } = await extract(['Summer 2027 Session 1', 'June 14 - 18', 'Founded in 2009.'], session('2027-06-14', '2027-06-18', cited));
    expect(preparedText).toContain(cited);
    expect(item.schedules.map((s) => [s.startDate, s.yearCitation])).toEqual([['2027-06-14', undefined]]);
  });

  it('a year cell above its date cell (cell-by-cell table) keeps today\'s behaviour, with another year on the page', async () => {
    const cited = '2027\n\nJune 14 - 18';
    const { item, preparedText } = await extract(['Year', 'Dates', '2027', 'June 14 - 18', 'Founded in 2009.'], session('2027-06-14', '2027-06-18', cited));
    expect(preparedText).toContain(cited);
    expect(item.schedules.map((s) => [s.startDate, s.yearCitation])).toEqual([['2027-06-14', undefined]]);
  });

  it('two-year text on a date line ("2026-27") is refused for either year', async () => {
    const cited = 'Week 1\n\nJune 14 – 18 (2026-27)';
    for (const year of ['2026', '2027']) {
      const { item } = await extract(['Week 1', 'June 14 – 18 (2026-27)'], session(`${year}-06-14`, `${year}-06-18`, cited));
      expect(item.schedules, year).toEqual([]);
    }
  });
});

describe('guards (fix round 4)', () => {
  it('rule 2 does not take a line that also states a date ("Registration opens Jan 5, 2027") as the year excerpt', async () => {
    const { item } = await extract(['Summer 2027 at the meadow.', 'Registration opens Jan 5, 2027.', '## Sessions', W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['Summer 2027 at the meadow.']);
  });

  it('a year excerpt stating two years fails at review in either order', () => {
    expect(excerptStatesOnlyYearOf('Dates for 2027 and 2026', ['2027-06-14'])).toBe(false);
    expect(excerptStatesOnlyYearOf('Dates for 2026 and 2027', ['2027-06-14'])).toBe(false);
  });
});

describe('two-digit years (fix round, low)', () => {
  it('"6/14/26" on the session\'s own line is a year there: no year is taken from a heading', async () => {
    const line = 'Week 1: 6/14/26 - 6/18/26';
    const { item } = await extract(['## 2027 Camp Dates', line], session('2027-06-14', '2027-06-18', line));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('its own line states 2026');
  });

  it('a "Summer \'26" heading is not read as no year: the 2027 sessions under it are refused', async () => {
    const { item } = await extract(['Summer 2027 at the meadow.', "## Summer '26", W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
  });

  it('a year glued to a table cell\'s time ("20269:00 AM") counts as another year on the page', async () => {
    const { item, preparedText } = await extract(['Summer 2027 at the meadow.', '## Sessions', W1, '20269:00 AM - 3:00 PM'], session('2027-06-14', '2027-06-18', W1));
    expect(preparedText).toContain('20269:00 AM');
    expect(item.schedules).toEqual([]);
  });
});
