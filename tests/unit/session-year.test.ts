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

describe('fix round 1: a number that is not a year', () => {
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

  it('a heading with a clear year and also a number that may be one is refused, not read for the clear one', async () => {
    const heading = '## 2027 Camp Dates, 2026 Pine Street';
    const { item } = await extract([heading, W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('has a number that may or may not be a year');
    expect(excerptStatesOnlyYearOf('Summer 2027, call 303-555-2026', ['2027-06-14'])).toBe(false);
  });

  it('reads years in the usual places', () => {
    for (const text of ['2027 Camp Dates', 'Summer 2027', 'Summer 2027 at the meadow.', '(2027)', 'June 14, 2027', '6/14/2027', '**2027 SUMMER DAY CAMP**', '## 2027 Camp Dates']) {
      expect(excerptStatesOnlyYearOf(text, ['2027-06-14']), text).toBe(true);
    }
  });
});

describe('fix round 1: a year on the session\'s own label line', () => {
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

  it('a label line stating another year is the session\'s own line, not text under the heading', async () => {
    const cited = 'Summer 2026 Session 1\n\nJune 14 - 18';
    const { item } = await extract(['## 2027 Camp Dates', 'Summer 2026 Session 1', 'June 14 - 18'], session('2027-06-14', '2027-06-18', cited));
    expect(item.schedules).toEqual([]);
    expect(yearNote(item)).toContain('its own line states 2026');
  });

  it('two-year text on a date line ("2026-27") is refused for either year', async () => {
    const cited = 'Week 1\n\nJune 14 – 18 (2026-27)';
    for (const year of ['2026', '2027']) {
      const { item } = await extract(['Week 1', 'June 14 – 18 (2026-27)'], session(`${year}-06-14`, `${year}-06-18`, cited));
      expect(item.schedules, year).toEqual([]);
    }
  });
});

describe('fix round 1: guards', () => {
  it('rule 2 does not take a line that also states a date ("Registration opens Jan 5, 2027") as the year excerpt', async () => {
    const { item } = await extract(['Summer 2027 at the meadow.', 'Registration opens Jan 5, 2027.', '## Sessions', W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['Summer 2027 at the meadow.']);
  });

  it('a year excerpt stating two years fails at review in either order', () => {
    expect(excerptStatesOnlyYearOf('Dates for 2027 and 2026', ['2027-06-14'])).toBe(false);
    expect(excerptStatesOnlyYearOf('Dates for 2026 and 2027', ['2027-06-14'])).toBe(false);
  });
});

describe('fix round 1: two-digit and glued years', () => {
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

describe('fix round 2 (superseded in part by round 4): a year followed by a dash and a number on a date line', () => {
  // A year, a dash and a time or a count is not a two-year range.
  // Round 4 supersedes this block's count and code lines: they now refuse
  // (see "fix round 4"). The time line stays accepted.
  const ACCEPTED = [
    'Week 1: June 14 - 18, 2027 - 10:00 AM to 2:00 PM',
  ];
  for (const line of ACCEPTED) {
    it(`"${line}" keeps today's behaviour`, async () => {
      const { item } = await extract([line], session('2027-06-14', '2027-06-18', line));
      expect(item.schedules.map((s) => [s.startDate, s.yearCitation])).toEqual([['2027-06-14', undefined]]);
    });
  }

  for (const line of ['Week 1: June 14 - 18 (2026-27)', 'Week 1: June 14 - 18, 2027-2028', 'Week 1: June 14 - 18, 2026/27']) {
    it(`"${line}" states two years and is refused for either`, async () => {
      for (const year of ['2026', '2027']) {
        const { item } = await extract([line], session(`${year}-06-14`, `${year}-06-18`, line));
        expect(item.schedules, year).toEqual([]);
      }
    });
  }

  it('a governing heading with a number that may be a year refuses, even when a line above clearly states the page\'s only year', async () => {
    // Without the refusal the heading would read as stating no year, and the
    // only-year rule would take "Summer 2027 at the meadow." instead.
    const { item } = await extract(['Summer 2027 at the meadow.', '## Lakeside Camp, 2027 Pine Street', W1], session('2027-06-14', '2027-06-18', W1));
    expect(item.schedules).toEqual([]);
  });
});

describe('fix round 3 (rule superseded by round 4; pins kept): two-year lines', () => {
  const TWO_YEARS = [
    'Week 1: June 14 - 18, 2026-27.',
    'Week 1: June 14 - 18, 2027-2028.',
    'Week 1: June 14 - 18, 2026-27: 9am-3pm',
    'Week 1: June 14 - 18, 2026-27/ages 5-12',
    'Week 1: June 14 - 18, 2026-27...',
    'Week 1: June 14 - 18, 2026/2027',
    'Week 1: June 14 - 18, 2026 to 2027',
    'Week 1: June 14 - 18 (2026 and 2027)',
    'Week 1: June 14 - 18, 2026-27 - 9:00 AM',
    'Week 1: June 14 - 18, 2026-27 - 12 spots left',
  ];
  for (const line of TWO_YEARS) {
    it(`"${line}" is refused for either year`, async () => {
      const years = [...line.matchAll(/20\d{2}/g)].map((m) => m[0]);
      const second = years.length > 1 && years[1]!.length === 4 ? years[1]! : String(Number(years[0]) + 1);
      for (const year of [years[0]!, second]) {
        const { item } = await extract([line], session(`${year}-06-14`, `${year}-06-18`, line));
        expect(item.schedules, year).toEqual([]);
      }
    });
  }

  it('"2027 - 28 spots" reads as a range and is refused (fail closed, accepted)', async () => {
    const line = 'Week 1: June 14 - 18, 2027 - 28 spots';
    const { item } = await extract([line], session('2027-06-14', '2027-06-18', line));
    expect(item.schedules).toEqual([]);
  });
});

describe('fix round 4 (exception rebound in round 5; pins kept): a date line states year Y only when Y is the only year it states', () => {
  const TWO_YEARS = [
    'Week 1: June 14 - 18, 2025-2027',
    'Week 1: June 14 - 18, 2026 – 2028',
    'Week 1: June 14 - 18, 2027–2026',
    'Week 1: June 14 - 18, 2026-28',
    'Week 1: June 14 - 18, 2099-00',
    'Week 1: June 14 - 18, 2020-2026-27',
    'Week 1: June 14 - 18, 2024 - 2026/27',
    'Week 1: June 14 - 18, 2026 through 2027',
    'Week 1: June 14 - 18, 2026 thru 2027',
    'Week 1: June 14 - 18, 2026\u20112027',
    'Week 1: June 14 - 18, 2026\u20102027',
    'Week 1: June 14 - 18, 2026\u22122027',
    "Week 1: June 14 - 18, 2026-'27",
    'Week 1: June 14 - 18, 2026, 2027',
    'Week 1: June 14 - 18, 2026 or 2027',
    // Accepted fail-closed recall cost: a count or a code after "YEAR -" reads as a second year.
    'Week 1: June 14 - 18, 2027 - 12 spots left',
    'Week 1: June 14 - 18, 2027 – 30 campers',
    'Week 1: June 14 - 18, 2027 - 28 spots',
    'Session 2027-01: June 14-18, 2027',
    // Two-digit second years through every joiner.
    'Week 1: June 14 - 18, 2026\u201127',
    'Week 1: June 14 - 18, 2026\u221227',
    "Week 1: June 14 - 18, 2026 through '27",
    "Week 1: June 14 - 18, 2026 or '27",
    "Week 1: June 14 - 18, 2026, '27",
    // Years after a week number are not dates' own years.
    'Week 1 2026 - Week 2 2027: June 14 - 18',
  ];
  for (const line of TWO_YEARS) {
    it(`${JSON.stringify(line)} is refused for every year it names`, async () => {
      const stated = new Set<string>();
      for (const m of line.matchAll(/(?:19|20)\d{2}/g)) stated.add(m[0]);
      for (const m of line.matchAll(/(?:19|20)(\d{2})\s*\S{1,8}?\s*'?(\d{2})(?!\d)/g)) stated.add(`20${m[2]}`);
      for (const year of stated) {
        const { item } = await extract([line], session(`${year}-06-14`, `${year}-06-18`, line));
        expect(item.schedules, year).toEqual([]);
      }
    });
  }

  const ONE_YEAR = [
    'Week 1: June 14 - 18, 2027 - 10:00 AM to 2:00 PM',
    'Week 1: June 14 - 18, 2027 - 9am',
    'June 14 - 18, 2027',
    'Week 1: June 14 - 18, 2027 (starts 2027-06-14)',
  ];
  for (const line of ONE_YEAR) {
    it(`${JSON.stringify(line)} states 2027 only and is accepted`, async () => {
      const { item } = await extract([line], session('2027-06-14', '2027-06-18', line));
      expect(item.schedules.map((s) => [s.startDate, s.yearCitation])).toEqual([['2027-06-14', undefined]]);
    });
  }

  it('a session across a year boundary with each date\'s own year on its line is still accepted (original brief)', async () => {
    const line = 'Winter week: December 28, 2026 - January 3, 2027';
    const { item } = await extract([line], session('2026-12-28', '2027-01-03', line));
    expect(item.schedules.map((s) => [s.startDate, s.endDate])).toEqual([['2026-12-28', '2027-01-03']]);
  });

  it('the three real-page shapes still come through', async () => {
    // A heading-year list cited narrowly and stretched; a year sentence above an undated list; a heading over linked dates.
    const a = await extract(['## 2027 Camp Dates', '<ul><li>Week 1: June 28 – July 2</li><li>Week 2: July 6 – July 9 (No camp July 5th)</li></ul>'],
      [...session('2027-06-28', '2027-07-02', '## 2027 Camp Dates\n\n-   Week 1: June 28 – July 2'), ...session('2027-07-06', '2027-07-09', '-   Week 2: July 6 – July 9 (No camp July 5th)')]);
    expect(a.preparedText).toContain('## 2027 Camp Dates\n\n-   Week 1: June 28 – July 2\n-   Week 2: July 6 – July 9 (No camp July 5th)');
    expect(a.item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['## 2027 Camp Dates', '## 2027 Camp Dates']);
    const u = await extract(['Hurry, the 2026 summer day camp has limited enrollment!', '### Camp Dates', 'Week 1 – Decades Week: June 8 – 12'],
      session('2026-06-08', '2026-06-12', 'Week 1 – Decades Week: June 8 – 12'));
    expect(u.item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['Hurry, the 2026 summer day camp has limited enrollment!']);
    const c = await extract(['## 2027 Summer Camp Sessions on the Island', '2027 Dates', 'Session #1', 'June 12 - June 18 (7-day)'],
      session('2027-06-12', '2027-06-18', 'June 12 - June 18 (7-day)'));
    expect(c.item.schedules.map((s) => s.yearCitation?.excerpt)).toEqual(['## 2027 Summer Camp Sessions on the Island']);
  });
});

describe('fix round 5: a multi-year date line binds each date to its own year', () => {
  const cases: [string, string, string, boolean][] = [
    ['December 28, 2026 - January 3, 2027', '2026-12-28', '2027-01-03', true],
    ['December 28, 2026 - January 3, 2027', '2027-12-28', '2027-01-03', false],
    ['December 28, 2026 - January 3, 2027', '2026-12-28', '2026-01-03', false],
    ['December 28, 2026 - January 3, 2027', '2027-12-28', '2028-01-03', false],
    ['June 14, 2026 - June 18, 2027', '2026-06-14', '2027-06-18', true],
    ['June 14, 2026 - June 18, 2027', '2027-06-14', '2027-06-18', false],
    ['June 14, 2026 - June 18, 2027', '2026-06-14', '2026-06-18', false],
    ['June 14 2026 (rescheduled from June 7 2025)', '2025-06-14', '2025-06-14', false],
    ['June 14 2026 (rescheduled from June 7 2025)', '2026-06-14', '2026-06-14', false],
    ['6/14/2026 - 6/18/2027', '2026-06-14', '2027-06-18', true],
    ['6/14/2026 - 6/18/2027', '2027-06-14', '2027-06-18', false],
    ['Week of June 14, 2026 (Class of 3, 2027)', '2027-06-14', '2027-06-18', false],
    ['Week of June 14, 2026 (Class of 3, 2027)', '2026-06-14', '2026-06-18', false],
    ['Week of June 14, 2026 (Grades 1-5, 2027)', '2026-06-14', '2026-06-18', false],
    ['June 14, 2026 and June 14, 2027', '2026-06-14', '2027-06-14', false],
    ['June 14, 2026 and June 14, 2027', '2027-06-14', '2027-06-14', false],
    ['Sessions: June 14, 2026; June 21, 2027', '2026-06-14', '2027-06-21', false],
    ['Sessions: June 14, 2026; June 21, 2027', '2026-06-14', '2026-06-21', false],
    ['28 December 2026 - 3 January 2027', '2026-12-28', '2027-01-03', true],
    ['28 December 2026 - 3 January 2027', '2027-12-28', '2027-01-03', false],
    ['June 18, 2027 - June 14, 2026', '2026-06-14', '2027-06-18', false],
    ['June 18, 2027 - June 14, 2026', '2027-06-18', '2026-06-14', false],
    // A day with no month name before a year is not a date: only one date on the line.
    ['June 14, 2026 - 18, 2027', '2026-06-14', '2027-06-18', false],
    ['June 14, 2026 to 3, 2027', '2026-06-14', '2027-06-03', false],
  ];
  for (const [line, start, end, accepted] of cases) {
    it(`${JSON.stringify(line)} as ${start}/${end} is ${accepted ? 'accepted' : 'refused'}`, async () => {
      const { item } = await extract(['## Sessions', line], session(start, end, line));
      expect(item.schedules.map((s) => [s.startDate, s.endDate])).toEqual(accepted ? [[start, end]] : []);
    });
  }
});

describe('fix round 5: the broad reading is the years a date line states', () => {
  const TWO_YEARS = [
    "Week 1: June 14 - 18, 2026 '27",
    'Week 1: June 14 - 18, 2026 ’27',
    "Week 1: June 14 - 18, 2026 summer '27",
    'Week 1: June 14 - 18, 2026-27am',
    'Week 1: June 14 - 18, 2026 - 27 PM',
    'Week 1: June 14 - 18, 2026 - 13pm',
    'Week 1: June 14 - 18, 2026 - 27:00',
    'June 14-18 2026, 6/21-6/25/27',
    'Week 1: June 14 - 18, 2026; 6/14/27',
    'Week 1: June 14 - 18, 2026/27/28',
    'Week 1: June 14 - 18, 2026-27-28',
    'Week 1: June 14 - 18, FY27 2026',
    "Week 1: June 14 - 18, FY'27 2026",
    'Week 1: June 14 - 18, ２０２６-２７',
    'Week 1: June 14 - 18, 2026-２７',
    'Week 1: June 14 - 18, 2026 | 27',
    'Week 1: June 14 - 18, 2026 ~ 27',
    'Week 1: June 14 - 18, 2026 + 27',
    'Week 1: June 14 - 18, 2026 · 27',
  ];
  for (const line of TWO_YEARS) {
    it(`${JSON.stringify(line)} is refused as 2026`, async () => {
      const { item } = await extract([line], session('2026-06-14', '2026-06-18', line));
      expect(item.schedules).toEqual([]);
    });
  }

  const ONE_YEAR = [
    'Week 1: June 14 - 18, 2027 - 10:00 AM to 2:00 PM',
    'Week 1: June 14 - 18, 2027 - 9am',
    'Week 1: June 14 - 18, 2027 - 9 a.m.',
    'Week 1: June 14 - 18, 2027 · 12:30 pm',
    'June 14 - 18, 2027',
    'Week 1: June 14 - 18, 2027 (starts 2027-06-14)',
    'Ages 5-12, June 14 - 18, 2027',
  ];
  for (const line of ONE_YEAR) {
    it(`${JSON.stringify(line)} states 2027 only and is accepted`, async () => {
      const { item } = await extract([line], session('2027-06-14', '2027-06-18', line));
      expect(item.schedules.map((s) => s.startDate)).toEqual(['2027-06-14']);
    });
  }
});
