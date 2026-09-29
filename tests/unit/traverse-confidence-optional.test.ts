import type { ExtractionProposal } from '@kontourai/traverse';
import { describe, expect, it } from 'vitest';

import { computeDiff } from '@/lib/ingestion/diff-engine';
import { assembledItemToDiffInputs } from '@/lib/ingestion/traverse-diff-inputs';
import { itemToProposedChanges, overallConfidence } from '@/lib/ingestion/traverse-extractor';
import { assembleItems, meanReportedConfidence } from '@/lib/ingestion/traverse-item-grouping';
import type { Camp } from '@/lib/types';

// Traverse 2.0: a proposal may carry no confidence. Nothing downstream may
// turn that into a number.
const p = (fieldPath: string, candidateValue: unknown, excerpt: string, pathIndices: number[], confidence?: number): ExtractionProposal => ({
  fieldPath, candidateValue, provenance: { excerpt, locator: 'chars:0-1' }, extractor: 'stub', pathIndices,
  ...(confidence === undefined ? {} : { confidence }),
});

const PROPOSALS = [
  p('items[].name', 'Unscored Camp', 'Unscored Camp', [0]),
  p('items[].city', 'Boulder', 'Boulder', [0]),
  p('items[].ageGroups[].minAge', 6, 'Ages 6-9', [0, 0], 0.8),
  p('items[].ageGroups[].maxAge', 9, 'Ages 6-9', [0, 0]),
  p('items[].campTypes[]', 'SUMMER_DAY', 'Summer day camp', [0, 0]),
];

describe('optional proposal confidence', () => {
  it('averages only when every value reported one', () => {
    expect(meanReportedConfidence([0.8, 0.6])).toBe(0.7);
    expect(meanReportedConfidence([0.8, undefined])).toBeUndefined();
    expect(meanReportedConfidence([])).toBeUndefined();
  });

  it('leaves confidence absent on grouped rows, list diffs and computeDiff inputs', () => {
    const [item] = assembleItems(PROPOSALS);
    expect(item!.scalars.name).not.toHaveProperty('confidence');
    expect(item!.ageGroups[0]).not.toHaveProperty('confidence');
    expect(item!.campTypes[0]).not.toHaveProperty('confidence');

    const changes = itemToProposedChanges(item!, {}, 'https://example.test');
    expect(changes.city).not.toHaveProperty('confidence');
    expect(changes.ageGroups).not.toHaveProperty('confidence');

    const { confidence } = assembledItemToDiffInputs(item!);
    expect(confidence).toEqual({});
    const diff = computeDiff({ city: 'Denver' } as unknown as Camp, { city: 'Boulder' }, confidence, {}, {}, 'https://example.test');
    expect(diff.city).toBeDefined();
    expect(diff.city).not.toHaveProperty('confidence');
  });

  it('keeps 0 only as the documented ordering key when nothing reported one', () => {
    expect(overallConfidence([PROPOSALS[0]!, PROPOSALS[1]!])).toBe(0);
    expect(overallConfidence(PROPOSALS)).toBe(0.8);
  });
});
