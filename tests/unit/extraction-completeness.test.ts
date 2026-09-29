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
});
