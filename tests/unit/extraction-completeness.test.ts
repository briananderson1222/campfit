import { describe, expect, it } from 'vitest';

import {
  describeIncompleteness,
  extractionIncompleteness,
  withholdListRemovalsFromIncompleteRun,
} from '@/lib/ingestion/extraction-completeness';
import type { ProposedChanges } from '@/lib/admin/types';

const INCOMPLETE = {
  reason: 'output-truncated' as const,
  coverage: [
    { chunk: 1, start: 0, end: 500, status: 'complete' as const },
    { chunk: 2, start: 450, end: 900, status: 'output-truncated' as const },
  ],
};

const CHANGES: ProposedChanges = {
  city: { old: 'Denver', new: 'Boulder', mode: 'update' },
  pricing: { old: [{ amount: 1 }, { amount: 2 }], new: [{ amount: 1 }], mode: 'update' },
  ageGroups: { old: [], new: [{ label: 'Ages 6-9' }], mode: 'populate' },
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

  it('withholds every list change except one into an empty field, and keeps scalars', () => {
    const { changes, warnings } = withholdListRemovalsFromIncompleteRun(CHANGES, INCOMPLETE);
    expect(Object.keys(changes).sort()).toEqual(['ageGroups', 'city']);
    expect(warnings.map((w) => w.split(' ')[0]).sort()).toEqual(['pricing', 'schedules']);
  });

  it('changes nothing on a complete run', () => {
    expect(withholdListRemovalsFromIncompleteRun(CHANGES, undefined)).toEqual({ changes: CHANGES, warnings: [] });
  });
});
