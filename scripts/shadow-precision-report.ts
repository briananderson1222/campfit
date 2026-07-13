import { evaluateShadowAutoAccept } from '@/lib/admin/shadow-auto-accept';
import { resolveProposalSnapshots } from '@/lib/admin/shadow-auto-accept-read';
import {
  getReviewedShadowProposals,
  type ReviewedShadowProposalRow,
} from '@/lib/admin/review-repository';
import type { ProposedChanges } from '@/lib/admin/types';

import { loadLocalEnv } from './load-env';

export const SHADOW_THRESHOLD_SWEEP = [0.7, 0.8, 0.85, 0.9, 0.95] as const;

export interface ShadowReportInput {
  readonly status: 'APPROVED' | 'REJECTED';
  readonly overallConfidence: number | null;
  readonly proposedChanges: ProposedChanges;
  readonly snapshotResolved: boolean;
}

export interface ShadowPrecisionRow {
  readonly threshold: number;
  readonly fieldClass: 'low-risk-only' | 'high-risk-present';
  readonly wouldAutoAcceptCount: number;
  readonly precision: number | null;
  readonly coverage: number;
}

/** Pure aggregation used by both the CLI and its deterministic tests. */
export function aggregateShadowPrecision(
  proposals: readonly ShadowReportInput[],
  thresholds: readonly number[] = SHADOW_THRESHOLD_SWEEP,
): ShadowPrecisionRow[] {
  const totalReviewed = proposals.length;
  const fieldClasses: ShadowPrecisionRow['fieldClass'][] = ['low-risk-only', 'high-risk-present'];

  return thresholds.flatMap((threshold) => fieldClasses.map((fieldClass) => {
    const evaluations = proposals.map((proposal) => ({
      proposal,
      verdict: evaluateShadowAutoAccept(proposal, { threshold }),
    }));
    const inClass = evaluations.filter(({ verdict }) => {
      const hasHighRisk = verdict.perField.some((field) => field.class === 'high-risk');
      return fieldClass === 'high-risk-present' ? hasHighRisk : !hasHighRisk;
    });
    const passing = inClass.filter(({ verdict }) => verdict.wouldAutoAccept);
    const approved = passing.filter(({ proposal }) => proposal.status === 'APPROVED').length;
    return {
      threshold,
      fieldClass,
      wouldAutoAcceptCount: passing.length,
      precision: passing.length === 0 ? null : approved / passing.length,
      coverage: totalReviewed === 0 ? 0 : passing.length / totalReviewed,
    };
  }));
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatShadowPrecisionTable(rows: readonly ShadowPrecisionRow[]): string {
  const header = 'θ     | field-class       | would-auto-accept count | precision | coverage';
  const divider = '------|-------------------|-------------------------|-----------|---------';
  const body = rows.map((row) => [
    row.threshold.toFixed(2).padEnd(5),
    row.fieldClass.padEnd(17),
    String(row.wouldAutoAcceptCount).padStart(23),
    percent(row.precision).padStart(9),
    percent(row.coverage).padStart(8),
  ].join(' | '));
  return [header, divider, ...body].join('\n');
}

async function withSnapshotResolution(rows: readonly ReviewedShadowProposalRow[]): Promise<ShadowReportInput[]> {
  const resolutions = await resolveProposalSnapshots(rows);
  return rows.map((proposal, index) => ({
    status: proposal.status,
    overallConfidence: proposal.overallConfidence,
    proposedChanges: proposal.proposedChanges,
    snapshotResolved: resolutions[index] ?? false,
  }));
}

async function main(): Promise<void> {
  loadLocalEnv();
  const reviewed = await getReviewedShadowProposals();
  const inputs = await withSnapshotResolution(reviewed);
  console.log(`Shadow auto-accept precision report (${inputs.length} reviewed proposals)`);
  console.log(formatShadowPrecisionTable(aggregateShadowPrecision(inputs)));
}

if (process.argv[1]?.endsWith('shadow-precision-report.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
