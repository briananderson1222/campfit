/**
 * computeDiff must not decide whether a reviewer sees a detected change on
 * the extractor's self-reported confidence (campfit#155). Confidence is kept
 * on the diff for ranking; a change that contradicts a recent approval is
 * flagged, not dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDiff, computeOverallConfidence } from '@/lib/ingestion/diff-engine';
import type { Camp } from '@/lib/types';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const FIVE_DAYS_AGO = new Date(NOW - 5 * 86_400_000).toISOString();
const FORTY_DAYS_AGO = new Date(NOW - 40 * 86_400_000).toISOString();

function camp(overrides: Partial<Camp> = {}): Camp {
  return { city: 'Denver', description: 'Old description', pricing: [], ...overrides } as unknown as Camp;
}

describe('computeDiff review gating', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a change that contradicts a value approved 5 days ago at confidence 0.79, flagged', () => {
    const changes = computeDiff(camp(), { city: 'Boulder' }, { city: 0.79 }, {}, { city: { approvedAt: FIVE_DAYS_AGO } });
    expect(changes.city).toEqual({
      old: 'Denver',
      new: 'Boulder',
      confidence: 0.79,
      contradictsRecentApproval: true,
      recentApprovalAt: FIVE_DAYS_AGO,
      mode: 'update',
    });
  });

  it('flags the same change at confidence 0.80 the same way', () => {
    const changes = computeDiff(camp(), { city: 'Boulder' }, { city: 0.8 }, {}, { city: { approvedAt: FIVE_DAYS_AGO } });
    expect(changes.city?.new).toBe('Boulder');
    expect(changes.city?.contradictsRecentApproval).toBe(true);
  });

  it('does not flag a change to a value approved outside the 30-day window', () => {
    const changes = computeDiff(camp(), { city: 'Boulder' }, { city: 0.79 }, {}, { city: { approvedAt: FORTY_DAYS_AGO } });
    expect(changes.city?.new).toBe('Boulder');
    expect(changes.city).not.toHaveProperty('contradictsRecentApproval');
    expect(changes.city).not.toHaveProperty('recentApprovalAt');
  });

  it('emits a description change at confidence 0.29', () => {
    const changes = computeDiff(camp(), { description: 'New description' }, { description: 0.29 });
    expect(changes.description).toMatchObject({ new: 'New description', confidence: 0.29, mode: 'update' });
  });

  it('emits a description change with no reported confidence, leaving confidence absent (not 0)', () => {
    const changes = computeDiff(camp(), { description: 'New description' }, {});
    expect(changes.description?.new).toBe('New description');
    expect(changes.description).not.toHaveProperty('confidence');
  });

  it('applies the same rules to relation fields', () => {
    const price = { label: 'Week', amount: 450, unit: 'PER_SESSION', durationWeeks: null, ageQualifier: null, discountNotes: null } as const;
    const lowConfidence = computeDiff(camp(), { pricing: [price] }, { pricing: 0.1 }, {}, { pricing: { approvedAt: FIVE_DAYS_AGO } });
    expect(lowConfidence.pricing).toMatchObject({ mode: 'populate', confidence: 0.1, contradictsRecentApproval: true });
    const noConfidence = computeDiff(camp(), { campTypes: ['SUMMER_DAY'] }, {});
    expect(noConfidence.campTypes?.new).toEqual(['SUMMER_DAY']);
    expect(noConfidence.campTypes).not.toHaveProperty('confidence');
  });

  it('computeOverallConfidence averages only reported confidences', () => {
    expect(computeOverallConfidence({
      a: { old: null, new: 'x', confidence: 0.9 },
      b: { old: null, new: 'y' },
    })).toBe(0.9);
    expect(computeOverallConfidence({ b: { old: null, new: 'y' } })).toBe(0);
  });
});
