/**
 * tests/integration/claim-corroboration.test.ts — pure-function coverage for
 * `lib/admin/claim-corroboration.ts`'s `deriveFieldCorroboration` (campfit#51,
 * Wave 1 Task 1.1, R2/AC2). No DB — lives under `tests/integration/` per
 * `tests/integration/trust-ranking.test.ts`'s convention of hosting
 * pure-function suites here so they run under the same `vitest run` command,
 * never touching the test pool.
 */
import { describe, expect, it } from 'vitest';

import { deriveFieldCorroboration, type ProposalHistoryRow } from '@/lib/admin/claim-corroboration';
import type { ProposalStatus, ProposedChanges } from '@/lib/admin/types';

function changes(field: string, newValue: unknown, sourceUrl = 'https://example.test/camp'): ProposedChanges {
  return { [field]: { old: null, new: newValue, confidence: 0.8, sourceUrl } };
}

function row(opts: {
  id: string;
  field: string;
  value: unknown;
  crawlRunId: string | null;
  sourceUrl?: string;
  status?: ProposalStatus;
  rejectedFields?: string[];
}): ProposalHistoryRow {
  return {
    id: opts.id,
    proposedChanges: changes(opts.field, opts.value, opts.sourceUrl),
    sourceUrl: opts.sourceUrl ?? 'https://example.test/camp',
    crawlRunId: opts.crawlRunId,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: opts.status ?? 'PENDING',
    rejectedFields: opts.rejectedFields ?? [],
  };
}

describe('deriveFieldCorroboration', () => {
  it('(a) matched by exactly one other, different-crawlRunId row -> exact: true, one corroborating id', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const other = row({ id: 'other', field: 'city', value: 'Austin', crawlRunId: 'run-2' });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, other],
    });
    expect(result.exact).toBe(true);
    expect(result.corroboratingProposalIds).toEqual(['other']);
  });

  it('(b) a match from the SAME crawlRunId as the target is not counted -> exact: false', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const sameRun = row({ id: 'sibling', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, sameRun],
    });
    expect(result.exact).toBe(false);
    expect(result.corroboratingProposalIds).toEqual([]);
  });

  it('(c) a near-miss value (different case/whitespace after trim, or a genuinely different string) -> exact: false', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const trimmedButDifferentCase = row({ id: 'other', field: 'city', value: '  austin  ', crawlRunId: 'run-2' });
    const genuinelyDifferent = row({ id: 'other2', field: 'city', value: 'Houston', crawlRunId: 'run-3' });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, trimmedButDifferentCase, genuinelyDifferent],
    });
    expect(result.exact).toBe(false);
  });

  it('(c2) whitespace-only difference after trim IS a match (trimmed equality, not case-insensitive)', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const trimmedMatch = row({ id: 'other', field: 'city', value: '  Austin  ', crawlRunId: 'run-2' });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, trimmedMatch],
    });
    expect(result.exact).toBe(true);
  });

  it('(d) zero history rows -> exact: false, empty arrays, no throw', () => {
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [],
    });
    expect(result.exact).toBe(false);
    expect(result.corroboratingProposalIds).toEqual([]);
    expect(result.corroboratingSourceUrls).toEqual([]);
    expect(result.sameSourceUrl).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('(e) two independent corroborating rows both collected, not just one', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const other1 = row({ id: 'other1', field: 'city', value: 'Austin', crawlRunId: 'run-2' });
    const other2 = row({ id: 'other2', field: 'city', value: 'Austin', crawlRunId: 'run-3' });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, other1, other2],
    });
    expect(result.exact).toBe(true);
    expect(result.corroboratingProposalIds.sort()).toEqual(['other1', 'other2']);
  });

  it('(f) sameSourceUrl reflects whether a corroborating row shares the target sourceUrl, even when exact', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1', sourceUrl: 'https://a.test/camp' });
    const sameSource = row({ id: 'other', field: 'city', value: 'Austin', crawlRunId: 'run-2', sourceUrl: 'https://a.test/camp' });
    const sameSourceResult = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, sameSource],
    });
    expect(sameSourceResult.exact).toBe(true);
    expect(sameSourceResult.sameSourceUrl).toBe(true);

    const differentSource = row({ id: 'other2', field: 'city', value: 'Austin', crawlRunId: 'run-2', sourceUrl: 'https://b.test/camp' });
    const differentSourceResult = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, differentSource],
    });
    expect(differentSourceResult.exact).toBe(true);
    expect(differentSourceResult.sameSourceUrl).toBe(false);
  });

  it('does not throw when the field is absent from a history row (skipped, not matched)', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const noFieldRow: ProposalHistoryRow = {
      id: 'other',
      proposedChanges: { name: { old: null, new: 'Something Else', confidence: 0.5 } },
      sourceUrl: 'https://example.test/camp',
      crawlRunId: 'run-2',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'PENDING',
      rejectedFields: [],
    };
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, noFieldRow],
    });
    expect(result.exact).toBe(false);
  });

  // Review H1 (null crawlRunId must never corroborate): entity-admin-repository.ts's
  // createCampProposal (admin-assistant path) always inserts crawlRunId: NULL,
  // so two non-independent assistant-authored proposals for the same
  // field/value must NOT be able to fake corroboration of each other just
  // because null !== null was never being compared for equality.
  it('(g) two null-crawlRunId proposals with the identical value are NOT corroborated', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: null });
    const otherNullRun = row({ id: 'other', field: 'city', value: 'Austin', crawlRunId: null });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: null,
      field: 'city',
      history: [target, otherNullRun],
    });
    expect(result.exact).toBe(false);
    expect(result.corroboratingProposalIds).toEqual([]);
  });

  it('(h) a null-crawlRunId proposal and a non-null-crawlRunId proposal with the identical value are NOT corroborated (either direction)', () => {
    const nullTarget = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: null });
    const nonNullOther = row({ id: 'other', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const nullSideResult = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: null,
      field: 'city',
      history: [nullTarget, nonNullOther],
    });
    expect(nullSideResult.exact).toBe(false);

    // Flip which side is the target: a non-null-run target must also not be
    // "corroborated" by a null-run row proposing the same value.
    const nonNullTarget = row({ id: 'target2', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const nullOther = row({ id: 'other2', field: 'city', value: 'Austin', crawlRunId: null });
    const nonNullSideResult = deriveFieldCorroboration({
      targetProposalId: 'target2',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [nonNullTarget, nullOther],
    });
    expect(nonNullSideResult.exact).toBe(false);
  });

  it('(i) two DISTINCT non-null crawlRunIds with the identical value ARE corroborated (existing behavior preserved)', () => {
    const target = row({ id: 'target', field: 'city', value: 'Austin', crawlRunId: 'run-1' });
    const other = row({ id: 'other', field: 'city', value: 'Austin', crawlRunId: 'run-2' });
    const result = deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-1',
      field: 'city',
      history: [target, other],
    });
    expect(result.exact).toBe(true);
    expect(result.corroboratingProposalIds).toEqual(['other']);
  });

  // campfit#156: a value a reviewer rejected is evidence against it, not
  // independent agreement.
  describe('reviewer rejections do not corroborate', () => {
    const target = row({ id: 'target', field: 'city', value: 'Boulder', crawlRunId: 'run-2' });
    const derive = (other: ProposalHistoryRow, field = 'city') => deriveFieldCorroboration({
      targetProposalId: 'target',
      targetCrawlRunId: 'run-2',
      field,
      history: [target, other],
    });

    it('a REJECTED proposal with the same value from an earlier run -> exact: false', () => {
      const rejected = row({ id: 'rejected', field: 'city', value: 'Boulder', crawlRunId: 'run-1', status: 'REJECTED' });
      expect(derive(rejected)).toMatchObject({ exact: false, corroboratingProposalIds: [] });
    });

    it('a REJECTED proposal corroborates no field, even one with no per-field rejection record', () => {
      const rejected = row({ id: 'rejected', field: 'city', value: 'Boulder', crawlRunId: 'run-1', status: 'REJECTED', rejectedFields: [] });
      expect(derive(rejected).exact).toBe(false);
    });

    it('per field: a reviewed proposal whose pricing was rejected still corroborates its city, not its pricing', () => {
      const price = [{ label: 'Week', amount: 450, unit: 'PER_SESSION' }];
      const reviewed: ProposalHistoryRow = {
        ...row({ id: 'reviewed', field: 'city', value: 'Boulder', crawlRunId: 'run-1', status: 'APPROVED', rejectedFields: ['pricing'] }),
        proposedChanges: {
          city: { old: null, new: 'Boulder', confidence: 0.8 },
          pricing: { old: null, new: price, confidence: 0.8 },
        },
      };
      const pricingTarget: ProposalHistoryRow = {
        ...target,
        proposedChanges: { ...target.proposedChanges, pricing: { old: null, new: price, confidence: 0.8 } },
      };
      const history = [pricingTarget, reviewed];
      expect(deriveFieldCorroboration({ targetProposalId: 'target', targetCrawlRunId: 'run-2', field: 'city', history }).exact).toBe(true);
      expect(deriveFieldCorroboration({ targetProposalId: 'target', targetCrawlRunId: 'run-2', field: 'pricing', history }).exact).toBe(false);
    });

    it('approved, still-pending and superseded (SKIPPED) rows with no rejection still corroborate', () => {
      for (const status of ['APPROVED', 'PENDING', 'SKIPPED'] as const) {
        const other = row({ id: 'other', field: 'city', value: 'Boulder', crawlRunId: 'run-1', status });
        expect(derive(other)).toMatchObject({ exact: true, corroboratingProposalIds: ['other'] });
      }
    });

    it('a still-pending proposal with a field rejected in a keep-pending review does not corroborate that field', () => {
      const pending = row({ id: 'pending', field: 'city', value: 'Boulder', crawlRunId: 'run-1', status: 'PENDING', rejectedFields: ['city'] });
      expect(derive(pending).exact).toBe(false);
    });
  });
});
