import { describe, expect, it } from 'vitest';

import {
  describeIncompleteness,
  hitOutputCap,
  extractionIncompleteness,
  limitListChangesToAdditions,
} from '@/lib/ingestion/extraction-completeness';
import type { ProposedChanges } from '@/lib/admin/types';

const INCOMPLETE = {
  reason: 'output-truncated' as const,
  coverage: [
    { chunk: 1, start: 0, end: 500, status: 'complete' as const },
    { chunk: 2, start: 450, end: 900, status: 'output-truncated' as const },
  ],
};

const tier = (label: string, amount: number) => ({ label, amount, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null });
const STANDARD = tier('Standard week', 425);
const EXTENDED = tier('Extended week', 525);
const EARLY = tier('Early bird', 395);

const CHANGES: ProposedChanges = {
  city: { old: 'Denver', new: 'Boulder', mode: 'update' },
  // Read text held Standard and a new Early bird tier; Extended sat in unread text.
  pricing: { old: [STANDARD, EXTENDED], new: [STANDARD, EARLY], mode: 'update' },
  // Read text held only an existing tag: nothing to add.
  campTypes: { old: ['SUMMER_DAY', 'OVERNIGHT'], new: ['summer_day'], mode: 'update' },
  ageGroups: { old: [], new: [{ label: 'Ages 6-9' }], mode: 'populate' },
  // Provider-source records diff lists against nothing: no current list to merge with.
  schedules: { old: null, new: [{ label: 'Week 1' }], mode: 'add_items' },
};

describe('extraction completeness', () => {
  it('reads the marker only from Traverse partial', () => {
    expect(extractionIncompleteness({})).toBeUndefined();
    expect(extractionIncompleteness(undefined)).toBeUndefined();
    expect(extractionIncompleteness({ partial: { reason: 'output-truncated', completedChunks: 2, remainingChunks: 0 }, coverage: INCOMPLETE.coverage }))
      .toEqual(INCOMPLETE);
  });

  it('names the reason and the ranges not fully read', () => {
    expect(describeIncompleteness(INCOMPLETE)).toBe('extraction incomplete (output-truncated): 1 of 2 text range(s) not fully read');
  });

  it('turns list changes into additions only, and withholds what it cannot prove', () => {
    const { changes, warnings } = limitListChangesToAdditions(CHANGES, INCOMPLETE);
    expect(Object.keys(changes).sort()).toEqual(['ageGroups', 'city', 'pricing']);
    // Every current tier is kept, the new one appended, nothing removed.
    expect(changes.pricing).toMatchObject({ old: [STANDARD, EXTENDED], new: [STANDARD, EXTENDED, EARLY], mode: 'add_items' });
    expect(warnings.some((w) => w.startsWith('pricing: 1 current entry not found in the read text kept, not removed'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('campTypes: 1 current entry'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('schedules change withheld'))).toBe(true);
  });

  it('changes nothing on a complete run', () => {
    expect(limitListChangesToAdditions(CHANGES, undefined)).toEqual({ changes: CHANGES, warnings: [] });
  });

  it('detects an output-cap stop from the reason or any coverage range', () => {
    expect(hitOutputCap(INCOMPLETE)).toBe(true);
    expect(hitOutputCap({ reason: 'provider-failure', coverage: INCOMPLETE.coverage })).toBe(true);
    expect(hitOutputCap({ reason: 'provider-failure', coverage: [{ chunk: 1, start: 0, end: 5, status: 'unread', reason: 'provider-failure' }] })).toBe(false);
  });

  // What the recrawl sends: times, discount notes, qualifiers and grades are
  // always null, labels come from the page's own text.
  describe('additions-only identity uses only the fields the extraction fills', () => {
    const session = (label: string, startDate: string, endDate: string, extra: Record<string, unknown> = {}) =>
      ({ label, startDate, endDate, startTime: null, endTime: null, earlyDropOff: null, latePickup: null, ...extra });
    const liveSessions = [
      session('Week 1: Nature', '2027-06-07', '2027-06-11', { id: 's1', startTime: '09:00', endTime: '15:00' }),
      session('Week 2: Rivers', '2027-06-14', '2027-06-18', { id: 's2', startTime: '09:00', endTime: '15:00', earlyDropOff: '08:00' }),
    ];
    const livePrice = [{ id: 'p1', label: 'Standard week', amount: 425, unit: 'PER_WEEK', durationWeeks: 1, ageQualifier: 'ages 6-9', discountNotes: 'Sibling discount 10%' }];
    const liveAges = [{ id: 'a1', label: 'Ages 6-9', minAge: 6, maxAge: 9, minGrade: 1, maxGrade: 3 }];
    const readSessions = [session('WEEK 1: NATURE', '2027-06-07', '2027-06-11'), session('week 2: rivers ', '2027-06-14', '2027-06-18')];
    const readPrice = [{ label: 'STANDARD WEEK', amount: 425, unit: 'PER_WEEK', durationWeeks: null, ageQualifier: null, discountNotes: null }];
    const readAges = [{ label: 'ages 6-9', minAge: 6, maxAge: 9, minGrade: null, maxGrade: null }];

    it('proposes nothing when nothing new was read (blanked fields and case variants are not new)', () => {
      const { changes } = limitListChangesToAdditions({
        schedules: { old: liveSessions, new: readSessions.slice(0, 1), mode: 'update' },
        pricing: { old: livePrice, new: readPrice, mode: 'update' },
        ageGroups: { old: liveAges, new: readAges, mode: 'update' },
      }, INCOMPLETE);
      expect(changes).toEqual({});
    });

    it('adds a genuinely new session, keeping every live entry unchanged', () => {
      const weekThree = session('Week 3: Peaks', '2027-06-21', '2027-06-25');
      const { changes } = limitListChangesToAdditions({
        schedules: { old: liveSessions, new: [...readSessions, weekThree], mode: 'update' },
      }, INCOMPLETE);
      expect(changes.schedules).toMatchObject({ mode: 'add_items', new: [...liveSessions, weekThree] });
    });
  });
});
