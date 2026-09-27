/**
 * A price the page does not state is not emitted (campfit#157): no amount is
 * not 0, no unit is not PER_WEEK, and the field excerpt comes from an entry
 * that was emitted. Covers both ingestion paths that consume assembled items:
 * first-pass `itemToProposedChanges` and re-crawl
 * `assembledItemToDiffInputs` -> `computeDiff`.
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

// Entry 0 states no price, entry 1 is complete, entry 2 states an amount but no unit.
const PROPOSALS: ExtractionProposal[] = [
  proposal('items[].name', [0], 'Test Camp', 'Test Camp'),
  proposal('items[].pricing[].amount', [0, 0], null, 'Pricing TBD'),
  proposal('items[].pricing[].amount', [0, 1], 450, '$450 per session'),
  proposal('items[].pricing[].unit', [0, 1], 'PER_SESSION', '$450 per session'),
  proposal('items[].pricing[].amount', [0, 2], 300, '$300 early bird'),
];

const EMITTED = [{
  label: '$450 per session',
  amount: 450,
  unit: 'PER_SESSION',
  durationWeeks: null,
  ageQualifier: null,
  discountNotes: null,
}];

function assembled() {
  const items = assembleItems(PROPOSALS);
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe('pricing entries the page does not state', () => {
  it('grouping keeps only the complete entry and warns naming each dropped label', () => {
    const item = assembled();
    expect(item.pricing).toEqual([{ amount: 450, unit: 'PER_SESSION', label: '$450 per session', confidence: 0.9 }]);
    const pricingWarnings = item.warnings.filter((w) => w.startsWith('pricing entry'));
    expect(pricingWarnings).toHaveLength(2);
    expect(pricingWarnings.find((w) => w.includes('"Pricing TBD"'))).toMatch(/no amount and unit/);
    expect(pricingWarnings.find((w) => w.includes('"$300 early bird"'))).toMatch(/no unit/);
  });

  it('first-pass path emits exactly the stated entry, with its own excerpt', () => {
    const changes = itemToProposedChanges(assembled(), {}, 'https://example.test/camp');
    expect(changes.pricing?.new).toEqual(EMITTED);
    expect(changes.pricing?.excerpt).toBe('$450 per session');
  });

  it('first-pass records carry the dropped-entry warning', () => {
    const result = { proposals: PROPOSALS, raw: { response: '', model: 'test' }, extractedAt: '2026-01-01T00:00:00.000Z' } as ExtractionResult;
    const [record] = buildTraverseItemProposalRecords(result, { sourceUrl: 'https://example.test/camp' });
    expect(record?.warnings.some((w) => w.includes('"Pricing TBD"'))).toBe(true);
    expect((record?.rawExtraction.warnings as string[]).some((w) => w.includes('"Pricing TBD"'))).toBe(true);
  });

  it('re-crawl path emits exactly the stated entry, with its own excerpt', () => {
    const { extracted, confidence, excerpts } = assembledItemToDiffInputs(assembled());
    expect(extracted.pricing).toEqual(EMITTED);
    expect(excerpts.pricing).toBe('$450 per session');
    const changes = computeDiff({ pricing: [] } as unknown as Camp, extracted, confidence, excerpts);
    expect(changes.pricing?.new).toEqual(EMITTED);
    expect(changes.pricing?.excerpt).toBe('$450 per session');
  });

  it('every emitted entry passes the pricing domain identity', () => {
    for (const entry of [
      ...(itemToProposedChanges(assembled()).pricing?.new as unknown[]),
      ...(assembledItemToDiffInputs(assembled()).extracted.pricing ?? []),
    ]) {
      expect(pricingDomainIdentity(entry).ok).toBe(true);
    }
  });

  it('an item whose only price entry is unstated emits no pricing change at all', () => {
    const [item] = assembleItems([
      proposal('items[].name', [0], 'Other Camp', 'Other Camp'),
      proposal('items[].pricing[].amount', [0, 0], null, 'Call for pricing'),
    ]);
    expect(item!.pricing).toEqual([]);
    expect(itemToProposedChanges(item!)).not.toHaveProperty('pricing');
    expect(assembledItemToDiffInputs(item!).extracted).not.toHaveProperty('pricing');
  });
});
