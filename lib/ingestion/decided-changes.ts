/**
 * decided-changes.ts — do not ask a reviewer the same question about the same page.
 *
 * An approval changes the camp, so the next crawl reads the page once more
 * (crawl-pipeline.ts, `skipEligibleFingerprint`). A model then words a value
 * differently, or leaves a list entry out, and the diff reports a change to a
 * field the reviewer has just approved from that very text.
 *
 * A change is withheld in exactly one case: the field was approved in review
 * (`fieldSources[field].approvedAt`), and the page text this crawl read in
 * full is the text the approved proposal was read from in full (the same
 * content fingerprint, which also covers the schema, the hints and the
 * provider). Once the text differs in any way, everything the model reports
 * as different is proposed: no narrower comparison (same excerpt, same row
 * labels) can show that a value did not change.
 *
 * Known limit: if a complete read missed something and the reviewer approved
 * it, a later read of the same text that finds it is withheld too. It is
 * named on the crawl log (`notProposedAgain`), and a manual edit or a
 * reviewer's recrawl after any page change lifts it.
 */
import type { ProposedChanges } from '@/lib/admin/types';

/** A camp's `fieldSources` entry, as review-apply writes it on approval. */
export interface DecidedFieldSource {
  approvedAt?: string;
  excerpt?: string | null;
  /** Fingerprint of the page text the approved proposal was read from, in full (content-fingerprint.ts). Absent on older approvals, after a manual edit, and for an approval made from an incomplete read. */
  contentFingerprint?: string | null;
}

export interface DecidedChange {
  field: string;
  approvedAt: string;
}

/**
 * Split a computed diff into the changes to propose and the ones a reviewer
 * already decided from this same page text.
 *
 * `completeReadFingerprint` is the fingerprint of the text this crawl read,
 * and must be passed only for a complete read.
 */
export function withholdDecidedChanges(
  changes: ProposedChanges,
  fieldSources: Readonly<Record<string, DecidedFieldSource | undefined>>,
  completeReadFingerprint?: string,
): { changes: ProposedChanges; decided: DecidedChange[]; warnings: string[] } {
  const kept: ProposedChanges = {};
  const decided: DecidedChange[] = [];
  for (const [field, diff] of Object.entries(changes)) {
    const source = fieldSources[field];
    if (source?.approvedAt && completeReadFingerprint && source.contentFingerprint === completeReadFingerprint) {
      decided.push({ field, approvedAt: source.approvedAt });
    } else {
      kept[field] = diff;
    }
  }
  const warnings = decided.map((item) =>
    `${item.field}: read differently this time but not proposed again — the page text is unchanged since a reviewer approved this field on ${item.approvedAt.slice(0, 10)}`);
  return { changes: kept, decided, warnings };
}
