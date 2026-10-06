/**
 * Session times are extracted when the page states them, with a citation, and
 * never filled in when it does not (owner decision: extract everything the
 * page states; what it does not state is called out for a steward).
 *
 * The extractions run through the real Relay extraction provider; only the
 * model runtime replays a written answer (tests/fixtures/real-crawl/replay.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ExtractionProposal } from '@kontourai/traverse';
import { buildRelayExtractionSchema } from '@kontourai/traverse/relay';

import { canonicalTime, textStatesTime, timesStatedIn } from '@/lib/ingestion/session-time';
import { CAMP_TARGET_SCHEMA } from '@/lib/ingestion/traverse-schema';
import { runTraverseExtraction } from '@/lib/ingestion/traverse-extractor';
import { assembleItems } from '@/lib/ingestion/traverse-item-grouping';
import { assembledItemToDiffInputs } from '@/lib/ingestion/traverse-diff-inputs';
import { computeDiff, keepUnstatedSessionTimes } from '@/lib/ingestion/diff-engine';
import type { Camp } from '@/lib/types';
import { createReplayProvider } from '../fixtures/real-crawl/replay';

const DATES_W1 = 'Week 1: June 14 - June 18, 2027';
const DATES_W2 = 'Week 2: June 21 - June 25, 2027';
const DAILY = 'Camp runs 9:00 AM - 3:30 PM every day.';

function page(lines: readonly string[]): string {
  return `<html><body><main><h1>Larkspur Meadow Day Camp</h1>${lines.map((line) => `<p>${line}</p>`).join('')}</main></body></html>`;
}

function answer(fieldPath: string, value: unknown, excerpt: string) {
  return { fieldPath, value, excerpt, locator: 'items[0]', occurrenceHint: 1 };
}

const SESSION_DATES = [
  answer('items[].name', 'Larkspur Meadow Day Camp', 'Larkspur Meadow Day Camp'),
  answer('items[].schedules[].startDate', '2027-06-14', DATES_W1),
  answer('items[].schedules[].endDate', '2027-06-18', DATES_W1),
  answer('items[].schedules[].startDate', '2027-06-21', DATES_W2),
  answer('items[].schedules[].endDate', '2027-06-25', DATES_W2),
];

async function extract(lines: readonly string[], proposals: readonly unknown[]) {
  const { provider } = createReplayProvider(proposals);
  const result = await runTraverseExtraction({ content: page(lines), sourceRef: 'https://larkspur.example.test/summer', provider });
  expect(result.error).toBeUndefined();
  const items = assembleItems(result.proposals as ExtractionProposal[]);
  expect(items).toHaveLength(1);
  return { result, item: items[0]! };
}

describe('reading a time from text', () => {
  it('reads a time only when the text says which half of the day it is in', () => {
    expect([...timesStatedIn('Camp runs 9:00 AM - 3:30 PM every day.')].sort()).toEqual(['3:30 PM', '9:00 AM']);
    expect([...timesStatedIn('Hours: 9-3pm')].sort()).toEqual(['3:00 PM', '9:00 AM']);
    expect([...timesStatedIn('1-4pm workshop')].sort()).toEqual(['1:00 PM', '4:00 PM']);
    expect([...timesStatedIn('9 a.m. to noon')].sort()).toEqual(['12:00 PM', '9:00 AM']);
    expect([...timesStatedIn('15:00–17:30')].sort()).toEqual(['3:00 PM', '5:30 PM']);
    // Not stated: no half of the day, or not a time at all.
    expect([...timesStatedIn('8:30-3:00')]).toEqual([]);
    expect([...timesStatedIn('June 9-13, 2026')]).toEqual([]);
    expect([...timesStatedIn('Ages 5-12, 9 amazing weeks')]).toEqual([]);
  });

  it('stores one spelling and refuses a value with no half of the day', () => {
    expect(canonicalTime('9am')).toBe('9:00 AM');
    expect(canonicalTime('3:30 p.m.')).toBe('3:30 PM');
    expect(canonicalTime('15:00')).toBe('3:00 PM');
    expect(canonicalTime('9:00')).toBeNull();
    expect(canonicalTime('')).toBeNull();
    expect(textStatesTime('9:00 AM', DAILY)).toBe(true);
    expect(textStatesTime('10:00 AM', DAILY)).toBe(false);
  });
});

describe('the extraction schema asks for session times', () => {
  it('declares a start and an end time per session, both in the strict output schema the provider receives', () => {
    const paths = CAMP_TARGET_SCHEMA.map((field) => field.path);
    expect(paths).toContain('items[].schedules[].startTime');
    expect(paths).toContain('items[].schedules[].endTime');
    const schema = JSON.stringify(buildRelayExtractionSchema(CAMP_TARGET_SCHEMA));
    expect(schema).toContain('items[].schedules[].startTime');
    expect(schema).toContain('items[].schedules[].endTime');
  });
});

describe('a crawled session time', () => {
  it('is extracted with its own citation; one daily time stated once applies to every session', async () => {
    // The model gives the daily time on each session; Traverse keeps one copy
    // of a repeated proposal (same field, value and text).
    const { result, item } = await extract([DATES_W1, DATES_W2, DAILY], [
      ...SESSION_DATES,
      answer('items[].schedules[].startTime', '9:00 AM', DAILY),
      answer('items[].schedules[].endTime', '3:30 PM', DAILY),
      answer('items[].schedules[].startTime', '9:00 AM', DAILY),
      answer('items[].schedules[].endTime', '3:30 PM', DAILY),
    ]);
    expect(result.proposals.filter((p) => p.fieldPath.endsWith('Time'))).toHaveLength(2);
    expect(item.schedules.map((s) => [s.label, s.startTime, s.endTime, s.timeCitations.map((c) => c.excerpt)])).toEqual([
      [DATES_W1, '9:00 AM', '3:30 PM', [DAILY]],
      [DATES_W2, '9:00 AM', '3:30 PM', [DAILY]],
    ]);

    const inputs = assembledItemToDiffInputs(item);
    expect(inputs.extracted.schedules?.map((s) => [s.startTime, s.endTime])).toEqual([['9:00 AM', '3:30 PM'], ['9:00 AM', '3:30 PM']]);
    expect(inputs.rowCitations.schedules?.map((c) => [c.excerpt, c.times?.map((t) => t.excerpt)])).toEqual([[DATES_W1, [DAILY]], [DATES_W2, [DAILY]]]);
    expect(inputs.rowCitations.schedules?.[0]?.times?.[0]?.locator).toMatch(/^chars:\d+-\d+$/);
  });

  it('is left out, not defaulted, when the page does not state one', async () => {
    const { item } = await extract([DATES_W1, DATES_W2], SESSION_DATES);
    expect(item.schedules.map((s) => [s.startTime, s.endTime, s.timeCitations])).toEqual([[null, null, []], [null, null, []]]);
    const inputs = assembledItemToDiffInputs(item);
    expect(inputs.extracted.schedules?.map((s) => [s.startTime, s.endTime])).toEqual([[null, null], [null, null]]);
    expect(inputs.rowCitations.schedules?.every((c) => c.times === undefined)).toBe(true);
  });

  it('is refused when its cited text does not state it, and the session is still proposed', async () => {
    const { item } = await extract([DATES_W1, DATES_W2, 'Ages 7 - 11'], [
      ...SESSION_DATES,
      answer('items[].schedules[].startTime', '9:00 AM', 'Ages 7 - 11'),
      answer('items[].schedules[].endTime', '3:00 PM', 'Ages 7 - 11'),
    ]);
    expect(item.schedules).toHaveLength(2);
    expect(item.schedules.map((s) => [s.startTime, s.endTime])).toEqual([[null, null], [null, null]]);
    expect(item.operatorWarnings.join('\n')).toContain('the time is not stated in the cited text');
  });

  it('is refused with only one end stated', async () => {
    const { item } = await extract([DATES_W1, DATES_W2, DAILY], [
      ...SESSION_DATES,
      answer('items[].schedules[].startTime', '9:00 AM', DAILY),
    ]);
    expect(item.schedules.map((s) => [s.startTime, s.endTime])).toEqual([[null, null], [null, null]]);
    expect(item.operatorWarnings.join('\n')).toContain('no end time was extracted');
  });

  it('stated with one session\'s dates goes to that session only, whatever row it arrived on', async () => {
    const w1 = 'Week 1: June 14 - June 18, 2027, 9:00 AM - 12:00 PM';
    const { item } = await extract([w1, DATES_W2], [
      answer('items[].name', 'Larkspur Meadow Day Camp', 'Larkspur Meadow Day Camp'),
      // Week 2 is listed first, so the one time pairs positionally with Week 2's row.
      answer('items[].schedules[].startDate', '2027-06-21', DATES_W2),
      answer('items[].schedules[].endDate', '2027-06-25', DATES_W2),
      answer('items[].schedules[].startDate', '2027-06-14', w1),
      answer('items[].schedules[].endDate', '2027-06-18', w1),
      answer('items[].schedules[].startTime', '9:00 AM', w1),
      answer('items[].schedules[].endTime', '12:00 PM', w1),
    ]);
    expect(item.schedules.map((s) => [s.startDate, s.startTime, s.endTime])).toEqual([
      ['2027-06-21', null, null],
      ['2027-06-14', '9:00 AM', '12:00 PM'],
    ]);
  });

  it('is not assigned when the page states several daily times without saying which session has which', async () => {
    const half = 'Half day: 9:00 AM - 12:00 PM.';
    const full = 'Full day: 9:00 AM - 3:00 PM.';
    const { item } = await extract([DATES_W1, DATES_W2, half, full], [
      ...SESSION_DATES,
      answer('items[].schedules[].startTime', '9:00 AM', half),
      answer('items[].schedules[].endTime', '12:00 PM', half),
      answer('items[].schedules[].startTime', '9:00 AM', full),
      answer('items[].schedules[].endTime', '3:00 PM', full),
    ]);
    expect(item.schedules.map((s) => [s.startTime, s.endTime])).toEqual([[null, null], [null, null]]);
    expect(item.operatorWarnings.join('\n')).toContain('2 different daily times');
  });
});

describe('a time placed by where its text is', () => {
  it('is refused when one text gives several sessions\' times at once', async () => {
    const line = 'June 14 - June 18, 2027: 9:00 AM - 12:00 PM; June 21 - June 25, 2027: 1:00 PM - 4:00 PM';
    const { item } = await extract([line], [
      answer('items[].name', 'Larkspur Meadow Day Camp', 'Larkspur Meadow Day Camp'),
      answer('items[].schedules[].startDate', '2027-06-14', line),
      answer('items[].schedules[].endDate', '2027-06-18', line),
      answer('items[].schedules[].startTime', '9:00 AM', line),
      answer('items[].schedules[].endTime', '12:00 PM', line),
      answer('items[].schedules[].startDate', '2027-06-21', line),
      answer('items[].schedules[].endDate', '2027-06-25', line),
      answer('items[].schedules[].startTime', '1:00 PM', line),
      answer('items[].schedules[].endTime', '4:00 PM', line),
    ]);
    expect(item.schedules.map((s) => [s.startDate, s.startTime, s.endTime])).toEqual([['2027-06-14', null, null], ['2027-06-21', null, null]]);
    expect(item.operatorWarnings.join('\n')).toContain('several sessions at once');
  });

  it('stated with one session\'s ordinal dates stays on that session', async () => {
    const w1 = 'Week 1: June 14th - 18th, 2027 from 9:00 AM - 12:00 PM';
    const { item } = await extract([w1, DATES_W2], [
      answer('items[].name', 'Larkspur Meadow Day Camp', 'Larkspur Meadow Day Camp'),
      answer('items[].schedules[].startDate', '2027-06-14', w1),
      answer('items[].schedules[].endDate', '2027-06-18', w1),
      answer('items[].schedules[].startTime', '9:00 AM', w1),
      answer('items[].schedules[].endTime', '12:00 PM', w1),
      answer('items[].schedules[].startDate', '2027-06-21', DATES_W2),
      answer('items[].schedules[].endDate', '2027-06-25', DATES_W2),
    ]);
    expect(item.schedules.map((s) => [s.startDate, s.startTime, s.endTime])).toEqual([['2027-06-14', '9:00 AM', '12:00 PM'], ['2027-06-21', null, null]]);
  });

  it.each([
    'All sessions run 9:00 AM - 3:30 PM.',
    'Hours for all weeks: 9:00 AM - 3:30 PM.',
    'Each week 9 am - 3:30 pm.',
  ])('a daily time stated for every session ("%s") applies to each', async (daily) => {
    const { item } = await extract([DATES_W1, DATES_W2, daily], [
      ...SESSION_DATES,
      answer('items[].schedules[].startTime', '9:00 AM', daily),
      answer('items[].schedules[].endTime', '3:30 PM', daily),
    ]);
    expect(item.schedules.map((s) => [s.startTime, s.endTime])).toEqual([['9:00 AM', '3:30 PM'], ['9:00 AM', '3:30 PM']]);
  });

  it('naming one session on a line of its own is not applied to every session', async () => {
    const hours = 'Week 1 hours: 9:00 AM - 12:00 PM';
    const { item } = await extract([DATES_W1, DATES_W2, hours], [
      ...SESSION_DATES,
      answer('items[].schedules[].startTime', '9:00 AM', hours),
      answer('items[].schedules[].endTime', '12:00 PM', hours),
    ]);
    expect(item.schedules.map((s) => [s.startTime, s.endTime])).toEqual([[null, null], [null, null]]);
  });
});

describe('a later crawl and a stored session time', () => {
  const stored = [{ id: 's1', label: DATES_W1, startDate: '2027-06-14', endDate: '2027-06-18', startTime: '9:00 AM', endTime: '3:00 PM', earlyDropOff: null, latePickup: null }];
  const crawled = (startTime: string | null, endTime: string | null) => [{ label: DATES_W1, startDate: '2027-06-14', endDate: '2027-06-18', startTime, endTime, earlyDropOff: null, latePickup: null }];
  const camp = { schedules: stored } as unknown as Camp;

  it('keeps the stored time when the page does not state one, so nothing is proposed', () => {
    expect(keepUnstatedSessionTimes(stored, crawled(null, null))).toEqual(crawled('9:00 AM', '3:00 PM'));
    expect(computeDiff(camp, { schedules: crawled(null, null) } as never, {}).schedules).toBeUndefined();
  });

  it('proposes a different stated time for review', () => {
    const changes = computeDiff(camp, { schedules: crawled('8:30 AM', '2:30 PM') } as never, {});
    expect((changes.schedules?.new as { startTime: string }[])[0]!.startTime).toBe('8:30 AM');
  });
});
