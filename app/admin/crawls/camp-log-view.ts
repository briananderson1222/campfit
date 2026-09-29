/**
 * app/admin/crawls/camp-log-view.ts — pure classification of a crawl camp-log
 * entry for the crawls page, split out of the `'use client'` page so it has a
 * unit-test surface (same reason as `schedule-panel-view.ts`).
 *
 * An entry whose extraction did not read all of its text (`incomplete`) is
 * its own outcome: "no changes" on such a run only means nothing changed in
 * the text that was read, so it must never be shown or counted as unchanged.
 */
import type { CrawlCampLogEntry } from '@/lib/admin/types';
import { listFieldLabel } from '@/lib/admin/proposal-extraction-status';

export type CampLogOutcome = 'error' | 'incomplete' | 'changed' | 'unchanged';

export function campLogOutcome(entry: Pick<CrawlCampLogEntry, 'status' | 'incomplete'>): CampLogOutcome {
  if (entry.status === 'error') return 'error';
  if (entry.incomplete) return 'incomplete';
  return entry.status === 'ok' ? 'changed' : 'unchanged';
}

export function campLogOutcomeCounts(entries: readonly Pick<CrawlCampLogEntry, 'status' | 'incomplete'>[]): Record<CampLogOutcome, number> {
  const counts: Record<CampLogOutcome, number> = { error: 0, incomplete: 0, changed: 0, unchanged: 0 };
  for (const entry of entries) counts[campLogOutcome(entry)]++;
  return counts;
}

/** The expanded row's explanation line, or null when the outcome needs none. */
export function campLogOutcomeNote(entry: Pick<CrawlCampLogEntry, 'status' | 'incomplete' | 'fieldsChanged'>): string | null {
  const outcome = campLogOutcome(entry);
  if (outcome === 'unchanged') return 'No changes detected — data looks current';
  if (outcome !== 'incomplete' || !entry.incomplete) return null;
  const ranges = entry.incomplete.unreadRanges > 0
    ? `${entry.incomplete.unreadRanges} text range(s) were not fully read`
    : 'part of the page was not read';
  const withheld = entry.incomplete.withheldListFields ?? [];
  const populated = entry.incomplete.populatedListFields ?? [];
  const names = (fields: readonly string[]) => fields.map(listFieldLabel).join(', ');
  const parts: string[] = [];
  if (withheld.length > 0) {
    parts.push(`List updates for ${names(withheld)} were withheld until a run reads the whole page; re-crawl, or edit manually.`);
  }
  if (populated.length > 0) {
    parts.push(`Filled from this partial read, so possibly missing entries: ${names(populated)}.`);
  }
  if (entry.fieldsChanged.length > 0) {
    parts.push('The proposal covers only what was read.');
  } else if (withheld.length === 0) {
    parts.push('No change was found in the text that was read; this is not a confirmation that the page is unchanged.');
  }
  const effect = parts.join(' ');
  return `Extraction incomplete (${entry.incomplete.reason}): ${ranges}. ${effect}`;
}

/**
 * How many processed pages of a run hit the provider's output cap, out of the
 * pages whose extraction ran (errors excluded). The rate the owner watches
 * after a Traverse or model change.
 */
export function outputCapCount(entries: readonly Pick<CrawlCampLogEntry, 'status' | 'incomplete'>[]): { truncated: number; extracted: number } {
  const extracted = entries.filter((entry) => entry.status !== 'error');
  return { truncated: extracted.filter((entry) => entry.incomplete?.outputTruncated === true).length, extracted: extracted.length };
}
