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
  const effect = entry.fieldsChanged.length > 0
    ? 'The proposal covers only what was read; list changes that could remove entries were withheld.'
    : 'No change was found in the text that was read; this is not a confirmation that the page is unchanged.';
  return `Extraction incomplete (${entry.incomplete.reason}): ${ranges}. ${effect}`;
}
