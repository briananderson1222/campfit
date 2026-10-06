import { describe, expect, it } from 'vitest';
import { withholdDecidedChanges } from '@/lib/ingestion/decided-changes';
import { plainLabel } from '@/lib/ingestion/traverse-diff-inputs';
import { campLogHeldBackLabel, campLogOutcomeNote } from '@/app/admin/crawls/camp-log-view';
import type { ProposedChanges } from '@/lib/admin/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { approveOutcome } from '@/app/admin/review/[id]/approve-outcome';
import { RowCitations } from '@/app/admin/review/[id]/row-citations';

const APPROVED_AT = '2026-09-30T12:00:00.000Z';
const PAGE = 'sha256:aaa';
const age = (label: string, minAge: number, maxAge: number) => ({ label, minAge, maxAge, minGrade: null, maxGrade: null });

describe('withholdDecidedChanges', () => {
  it('withholds any approved field, an enum list included, when the page text is the text it was approved from', () => {
    const changes: ProposedChanges = {
      campTypes: { old: ['SCHOOL_BREAK', 'SUMMER_DAY'], new: ['SCHOOL_BREAK'], excerpt: 'Spring Safari' },
      description: { old: 'A week of outdoor science.', new: 'One week of outdoor science.', excerpt: 'Spend a week on outdoor science.' },
    };
    const source = { approvedAt: APPROVED_AT, contentFingerprint: PAGE };
    const result = withholdDecidedChanges(changes, { campTypes: source, description: source }, PAGE);
    expect(result.changes).toEqual({});
    expect(result.decided).toEqual([{ field: 'campTypes', approvedAt: APPROVED_AT }, { field: 'description', approvedAt: APPROVED_AT }]);
    expect(result.warnings[0]).toBe('campTypes: read differently this time but not proposed again — the page text is unchanged since a reviewer approved this field on 2026-09-30');
  });

  it('proposes everything once the page text differs, whatever the excerpts and row labels say', () => {
    const source = { approvedAt: APPROVED_AT, excerpt: 'Ages 6 - 10', contentFingerprint: PAGE };
    const changes: ProposedChanges = {
      // The same excerpt, a different value.
      city: { old: 'Golden', new: 'Boulder', excerpt: 'Ages 6 - 10' },
      // The same row label, a different value: a header-cited row whose price or age moved.
      ageGroups: { old: [age('Ages 6 - 10', 6, 10)], new: [age('Ages 6 - 10', 6, 11)], excerpt: 'Ages 6 - 10' },
      // The same values under another label.
      pricing: { old: [{ label: '15 Day Sessions', amount: 3850, unit: 'PER_SESSION' }], new: [{ label: 'Two weeks', amount: 3850, unit: 'PER_SESSION' }], excerpt: 'Two weeks' },
    };
    const result = withholdDecidedChanges(changes, { city: source, ageGroups: source, pricing: source }, 'sha256:bbb');
    expect(Object.keys(result.changes)).toEqual(['city', 'ageGroups', 'pricing']);
    expect(result.decided).toEqual([]);
  });

  it('proposes when this read has no fingerprint (an incomplete read) or the approval recorded none', () => {
    const changes: ProposedChanges = { city: { old: 'Golden', new: 'Boulder', excerpt: 'Located in Boulder.' } };
    expect(Object.keys(withholdDecidedChanges(changes, { city: { approvedAt: APPROVED_AT, contentFingerprint: PAGE } }).changes)).toEqual(['city']);
    expect(Object.keys(withholdDecidedChanges(changes, { city: { approvedAt: APPROVED_AT } }, PAGE).changes)).toEqual(['city']);
    expect(Object.keys(withholdDecidedChanges(changes, { city: { approvedAt: APPROVED_AT, contentFingerprint: null } }, PAGE).changes)).toEqual(['city']);
    // Neither side has one (an older approval, an incomplete read): not the same page.
    expect(Object.keys(withholdDecidedChanges(changes, { city: { approvedAt: APPROVED_AT } }).changes)).toEqual(['city']);
  });

  it('proposes a field no reviewer approved, even on the same page text', () => {
    const changes: ProposedChanges = { city: { old: 'Denver', new: 'Golden', excerpt: 'Located in Golden.' } };
    expect(Object.keys(withholdDecidedChanges(changes, {}, PAGE).changes)).toEqual(['city']);
    expect(Object.keys(withholdDecidedChanges(changes, { city: { contentFingerprint: PAGE } }, PAGE).changes)).toEqual(['city']);
  });
});

describe('a crawl that held something back does not read as plain "no changes"', () => {
  it('labels the row and explains it', () => {
    const entry = { status: 'no_changes' as const, fieldsChanged: [], notProposedAgain: ['campTypes', 'city'] };
    expect(campLogHeldBackLabel(entry)).toBe('2 not re-proposed');
    expect(campLogOutcomeNote(entry)).toBe(
      'No new proposal — 2 field(s) were read differently but not proposed again, because a reviewer approved them from this same page text: campTypes, city. Recrawl from the review page to ask again.',
    );
    expect(campLogHeldBackLabel({})).toBeNull();
    expect(campLogOutcomeNote({ status: 'no_changes', fieldsChanged: [] })).toBe('No changes detected — data looks current');
  });
});

describe('plainLabel', () => {
  it('takes the page preparation\'s Markdown out of a row label and leaves plain text alone', () => {
    expect(plainLabel('**First Session:** June 6th - June 20th, 2027')).toBe('First Session: June 6th - June 20th, 2027');
    expect(plainLabel('15 Day Sessions\n*Ages 8 - 10*\n**$3,850**')).toBe('15 Day Sessions Ages 8 - 10 $3,850');
    expect(plainLabel('## [Pine Ridge Junior Camp](/camps/juniors-ages-8-10)')).toBe('Pine Ridge Junior Camp');
    expect(plainLabel('Ages 8 - 10')).toBe('Ages 8 - 10');
    // Not emphasis: a lone asterisk, a multiplication, an underscore inside a word.
    expect(plainLabel('$450 per week * sibling discount')).toBe('$450 per week * sibling discount');
    expect(plainLabel('2 * 3 sessions, see camp_fees')).toBe('2 * 3 sessions, see camp_fees');
  });
});

describe('after an approve, the review page', () => {
  it('moves on when everything was recorded, and stays to show what was not', () => {
    expect(approveOutcome({})).toEqual({ stay: false, message: null });
    const outcome = approveOutcome({ provenanceErrors: [{ step: 'writeChangeLogs', message: 'change log write blocked' }] });
    expect(outcome.stay).toBe(true);
    expect(outcome.message).toBe("Applied, but a follow-up step failed (writeChangeLogs): change log write blocked. The camp's verification status or history may be out of date until the next change.");
  });

  it('shows each proposed row next to the text it cites', () => {
    const html = renderToStaticMarkup(createElement(RowCitations, { proposedChanges: {
      schedules: { old: [], new: [{ label: 'Session One', startDate: '2027-06-07', endDate: '2027-06-11' }, { label: 'Session Two', startDate: '2027-06-14', endDate: '2027-06-18' }],
        rowCitations: [{ excerpt: 'Session One: June 7 - June 11, 2027' }] },
      city: { old: 'A', new: 'B', excerpt: 'B' },
    } }));
    expect(html).toContain('data-testid="row-citations"');
    expect(html.match(/data-testid="row-citation"/g)).toHaveLength(2);
    expect(html).toContain('Session One · 2027-06-07 – 2027-06-11</span><span class="grid gap-0.5"><q class="break-words text-xs text-bark-500">Session One: June 7 - June 11, 2027</q></span>');
    expect(html).toContain('Session Two · 2027-06-14 – 2027-06-18</span><span class="grid gap-0.5"><q class="break-words text-xs text-bark-500">no citation</q></span>');
    expect(renderToStaticMarkup(createElement(RowCitations, { proposedChanges: { city: { old: 'A', new: 'B' } } }))).toBe('');
  });
});
