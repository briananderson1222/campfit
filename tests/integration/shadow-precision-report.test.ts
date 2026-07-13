import { describe, expect, it } from 'vitest';

import {
  aggregateShadowPrecision,
  formatShadowPrecisionTable,
  type ShadowReportInput,
} from '@/scripts/shadow-precision-report';

function proposal(overrides: Partial<ShadowReportInput> = {}): ShadowReportInput {
  return {
    status: 'APPROVED',
    overallConfidence: 0.95,
    proposedChanges: { description: { old: 'old', new: 'new', confidence: 0.95, excerpt: 'new' } },
    snapshotResolved: true,
    ...overrides,
  };
}

describe('shadow precision report aggregation', () => {
  it('calculates precision and total-reviewed coverage for each threshold and field class', () => {
    const rows = aggregateShadowPrecision([
      proposal(),
      proposal({ status: 'REJECTED', overallConfidence: 0.92 }),
      proposal({ overallConfidence: 0.75 }),
      proposal({ proposedChanges: { pricing: { old: null, new: [{ amount: 10 }], confidence: 0.99, excerpt: '$10' } } }),
    ], [0.9]);

    expect(rows).toEqual([
      { threshold: 0.9, fieldClass: 'low-risk-only', wouldAutoAcceptCount: 2, precision: 0.5, coverage: 0.5 },
      { threshold: 0.9, fieldClass: 'high-risk-present', wouldAutoAcceptCount: 0, precision: null, coverage: 0 },
    ]);
  });

  it('prints the requested stable table columns', () => {
    const table = formatShadowPrecisionTable(aggregateShadowPrecision([proposal()], [0.9]));
    expect(table).toContain('θ     | field-class');
    expect(table).toContain('would-auto-accept count | precision | coverage');
    expect(table).toContain('low-risk-only');
    expect(table).toContain('100.0%');
  });
});
