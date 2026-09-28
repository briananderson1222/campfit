/**
 * A price the page does not state is not emitted (campfit#157): no amount is
 * not 0 and no unit is not PER_WEEK. Because approving a pricing change
 * replaces the camp's whole price list, a list with any unextractable tier is
 * withheld entirely rather than proposed partially. Covers both ingestion
 * paths that consume assembled items: first-pass `itemToProposedChanges` and
 * re-crawl `assembledItemToDiffInputs` -> `computeDiff`.
 */
import type { ExtractionProposal, ExtractionResult } from '@kontourai/traverse';
import { describe, expect, it } from 'vitest';

import { computeDiff } from '@/lib/ingestion/diff-engine';
import { pricingDomainIdentity } from '@/lib/ingestion/diff-policy';
import { assembledItemToDiffInputs } from '@/lib/ingestion/traverse-diff-inputs';
import { buildTraverseItemProposalRecords, itemToProposedChanges } from '@/lib/ingestion/traverse-extractor';
import { assembleItems } from '@/lib/ingestion/traverse-item-grouping';
import type { Camp } from '@/lib/types';

let offset = 0;
function proposal(fieldPath: string, pathIndices: number[], candidateValue: unknown, excerpt: string): ExtractionProposal {
  const start = offset;
  offset += excerpt.length + 1;
  return {
    fieldPath,
    pathIndices,
    candidateValue,
    confidence: 0.9,
    provenance: { excerpt, locator: `chars:${start}-${start + excerpt.length}` },
    extractor: 'test-extractor',
  };
}

const NAME = proposal('items[].name', [0], 'Test Camp', 'Test Camp');

// Entry 0 states no price, entry 1 is complete, entry 2 states an amount but no unit.
const MIXED: ExtractionProposal[] = [
  NAME,
  proposal('items[].pricing[].amount', [0, 0], null, 'Pricing TBD'),
  proposal('items[].pricing[].amount', [0, 1], 450, '$450 per session'),
  proposal('items[].pricing[].unit', [0, 1], 'PER_SESSION', '$450 per session'),
  proposal('items[].pricing[].amount', [0, 2], 300, '$300 early bird'),
];

const COMPLETE: ExtractionProposal[] = [
  NAME,
  proposal('items[].pricing[].amount', [0, 0], 450, '$450 per session'),
  proposal('items[].pricing[].unit', [0, 0], 'PER_SESSION', '$450 per session'),
  proposal('items[].pricing[].amount', [0, 1], 90, '$90 per day'),
  proposal('items[].pricing[].unit', [0, 1], 'PER_DAY', '$90 per day'),
];

const LIVE_PRICING = [
  { id: 'p1', label: 'Standard', amount: 450, unit: 'PER_SESSION', durationWeeks: null, ageQualifier: null, discountNotes: null },
  { id: 'p2', label: 'Members', amount: 300, unit: 'PER_SESSION', durationWeeks: null, ageQualifier: null, discountNotes: null },
];

function only(proposals: ExtractionProposal[]) {
  const items = assembleItems(proposals);
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe('pricing entries the page does not state', () => {
  it('drops each incomplete tier with a warning naming it, and withholds the partial list', () => {
    const item = only(MIXED);
    expect(item.pricing).toEqual([]);
    expect(item.operatorWarnings.find((w) => w.includes('"Pricing TBD"'))).toMatch(/no amount and unit/);
    expect(item.operatorWarnings.find((w) => w.includes('"$300 early bird"'))).toMatch(/no unit/);
    expect(item.operatorWarnings.find((w) => w.startsWith('pricing change withheld'))).toContain('"$450 per session"');
    for (const w of item.operatorWarnings) expect(item.warnings).toContain(w);
  });

  it('neither path proposes a pricing change that would replace live tiers', () => {
    const item = only(MIXED);
    expect(itemToProposedChanges(item, {}, 'https://example.test/camp')).not.toHaveProperty('pricing');
    const { extracted, confidence, excerpts } = assembledItemToDiffInputs(item);
    expect(extracted).not.toHaveProperty('pricing');
    const changes = computeDiff({ pricing: LIVE_PRICING } as unknown as Camp, extracted, confidence, excerpts);
    expect(changes).not.toHaveProperty('pricing');
  });

  it('first-pass records carry the operator warnings', () => {
    const result = { proposals: MIXED, raw: { response: '', model: 'test' }, extractedAt: '2026-01-01T00:00:00.000Z' } as ExtractionResult;
    const [record] = buildTraverseItemProposalRecords(result, { sourceUrl: 'https://example.test/camp' });
    expect(record?.operatorWarnings?.some((w) => w.includes('"Pricing TBD"'))).toBe(true);
    expect((record?.rawExtraction.warnings as string[]).some((w) => w.includes('"Pricing TBD"'))).toBe(true);
  });

  it('a fully stated list is emitted with each tier\'s own extracted unit and an emitted excerpt, in both paths', () => {
    const item = only(COMPLETE);
    expect(item.operatorWarnings).toEqual([]);
    const expected = [
      { label: '$450 per session', amount: 450, unit: 'PER_SESSION', durationWeeks: null, ageQualifier: null, discountNotes: null },
      { label: '$90 per day', amount: 90, unit: 'PER_DAY', durationWeeks: null, ageQualifier: null, discountNotes: null },
    ];
    const firstPass = itemToProposedChanges(item, {}, 'https://example.test/camp');
    expect(firstPass.pricing?.new).toEqual(expected);
    expect(firstPass.pricing?.excerpt).toBe('$450 per session');
    const { extracted, confidence, excerpts } = assembledItemToDiffInputs(item);
    expect(extracted.pricing).toEqual(expected);
    expect(excerpts.pricing).toBe('$450 per session');
    expect(computeDiff({ pricing: [] } as unknown as Camp, extracted, confidence, excerpts).pricing?.new).toEqual(expected);
    for (const entry of expected) expect(pricingDomainIdentity(entry).ok).toBe(true);
  });

  it('an item whose only price entry is unstated emits no pricing change, with a warning', () => {
    const item = only([
      proposal('items[].name', [0], 'Other Camp', 'Other Camp'),
      proposal('items[].pricing[].amount', [0, 0], null, 'Call for pricing'),
    ]);
    expect(item.pricing).toEqual([]);
    expect(item.operatorWarnings.some((w) => w.includes('"Call for pricing" dropped'))).toBe(true);
    expect(itemToProposedChanges(item)).not.toHaveProperty('pricing');
    expect(assembledItemToDiffInputs(item).extracted).not.toHaveProperty('pricing');
  });
});
