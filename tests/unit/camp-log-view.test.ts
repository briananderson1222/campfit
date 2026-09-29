import { describe, expect, it } from 'vitest';

import { campLogOutcome, campLogOutcomeCounts, campLogOutcomeNote, outputCapCount } from '@/app/admin/crawls/camp-log-view';

describe('crawl camp-log outcome', () => {
  it('never shows an incomplete run as unchanged or plainly changed', () => {
    const incomplete = { reason: 'provider-failure', unreadRanges: 2 };
    expect(campLogOutcome({ status: 'no_changes', incomplete })).toBe('incomplete');
    expect(campLogOutcome({ status: 'ok', incomplete })).toBe('incomplete');
    expect(campLogOutcome({ status: 'error', incomplete })).toBe('error');
    expect(campLogOutcome({ status: 'no_changes' })).toBe('unchanged');
    expect(campLogOutcome({ status: 'ok' })).toBe('changed');

    const note = campLogOutcomeNote({ status: 'no_changes', incomplete, fieldsChanged: [] })!;
    expect(note).toContain('Extraction incomplete (provider-failure)');
    expect(note).toContain('not a confirmation that the page is unchanged');
    expect(note).not.toContain('data looks current');
    expect(campLogOutcomeNote({ status: 'no_changes', fieldsChanged: [] })).toBe('No changes detected — data looks current');
  });

  it('counts incomplete entries on their own', () => {
    expect(campLogOutcomeCounts([
      { status: 'ok' },
      { status: 'no_changes' },
      { status: 'no_changes', incomplete: { reason: 'max-chunks', unreadRanges: 3 } },
      { status: 'error' },
    ])).toEqual({ changed: 1, unchanged: 1, incomplete: 1, error: 1 });
  });

  it('counts pages that hit the output cap among pages that were extracted', () => {
    expect(outputCapCount([
      { status: 'ok', incomplete: { reason: 'output-truncated', unreadRanges: 1, outputTruncated: true } },
      { status: 'no_changes', incomplete: { reason: 'provider-failure', unreadRanges: 1, outputTruncated: false } },
      { status: 'no_changes' },
      { status: 'error' },
      // Written before the flag existed: not counted as a cap hit.
      { status: 'no_changes', incomplete: { reason: 'output-truncated', unreadRanges: 1 } },
    ])).toEqual({ truncated: 1, extracted: 4 });
  });

  it('builds the incomplete note from what was actually withheld or filled', () => {
    const base = { reason: 'output-truncated', unreadRanges: 1, outputTruncated: true };
    const listsOnly = campLogOutcomeNote({
      status: 'no_changes', fieldsChanged: [],
      incomplete: { ...base, withheldListFields: ['schedules', 'pricing', 'ageGroups'] },
    })!;
    expect(listsOnly).toContain('List updates for sessions, pricing, age groups were withheld');
    expect(listsOnly).not.toContain('No change was found');

    const scalarOnly = campLogOutcomeNote({ status: 'ok', fieldsChanged: ['city'], incomplete: base })!;
    expect(scalarOnly).toContain('The proposal covers only what was read.');
    expect(scalarOnly).not.toContain('withheld');

    const populated = campLogOutcomeNote({ status: 'ok', fieldsChanged: ['ageGroups'], incomplete: { ...base, populatedListFields: ['ageGroups'] } })!;
    expect(populated).toContain('possibly missing entries: age groups');
    expect(populated).not.toContain('withheld');
  });
});
