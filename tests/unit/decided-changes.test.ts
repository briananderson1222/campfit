import { describe, expect, it } from 'vitest';
import { withholdDecidedChanges } from '@/lib/ingestion/decided-changes';
import { plainLabel } from '@/lib/ingestion/traverse-diff-inputs';
import type { ProposedChanges } from '@/lib/admin/types';

const APPROVED_AT = '2026-09-30T12:00:00.000Z';
const age = (label: string, minAge: number, maxAge: number) => ({ label, minAge, maxAge, minGrade: null, maxGrade: null });

describe('withholdDecidedChanges', () => {
  it('withholds a reworded value that cites the excerpt a reviewer approved', () => {
    const changes: ProposedChanges = {
      description: { old: 'A week of outdoor science.', new: 'One week of outdoor science.', excerpt: 'Spend  a week\non outdoor science.' },
    };
    const result = withholdDecidedChanges(changes, { description: { approvedAt: APPROVED_AT, excerpt: 'Spend a week on outdoor science.' } });
    expect(result.changes).toEqual({});
    expect(result.decided).toEqual([{ field: 'description', approvedAt: APPROVED_AT, reason: 'same-excerpt' }]);
    expect(result.warnings).toEqual(['description: not proposed again — the page text it cites is the text a reviewer approved on 2026-09-30']);
  });

  it('proposes a value that cites different page text', () => {
    const changes: ProposedChanges = { description: { old: 'A week of outdoor science.', new: 'Two weeks of outdoor science.', excerpt: 'Now two weeks of outdoor science.' } };
    const result = withholdDecidedChanges(changes, { description: { approvedAt: APPROVED_AT, excerpt: 'Spend a week on outdoor science.' } });
    expect(Object.keys(result.changes)).toEqual(['description']);
    expect(result.decided).toEqual([]);
  });

  it('proposes a field no reviewer approved, even with the same excerpt', () => {
    const changes: ProposedChanges = { city: { old: 'Denver', new: 'Golden', excerpt: 'Located in Golden.' } };
    expect(Object.keys(withholdDecidedChanges(changes, {}).changes)).toEqual(['city']);
    // An attested or discovered source has an excerpt but no approval.
    expect(Object.keys(withholdDecidedChanges(changes, { city: { excerpt: 'Located in Golden.' } }).changes)).toEqual(['city']);
    // An approval that recorded no excerpt decided nothing about this text.
    expect(Object.keys(withholdDecidedChanges({ city: { old: 'Denver', new: 'Golden' } }, { city: { approvedAt: APPROVED_AT, excerpt: null } }).changes)).toEqual(['city']);
  });

  it('withholds a row list that cites the stored rows\' excerpts, or carries their values', () => {
    const sameExcerpts: ProposedChanges = { ageGroups: { old: [age('Ages 6 - 10', 6, 10)], new: [age('Ages 6 - 10', 6, 11)], excerpt: 'Ages 6 - 10' } };
    expect(withholdDecidedChanges(sameExcerpts, { ageGroups: { approvedAt: APPROVED_AT } }).decided.map((d) => d.reason)).toEqual(['same-excerpt']);

    const sameValues: ProposedChanges = { ageGroups: { old: [age('Ages 6 - 10', 6, 10)], new: [age('*Ages 6 - 10*', 6, 10)], excerpt: '*Ages 6 - 10*' } };
    const result = withholdDecidedChanges(sameValues, { ageGroups: { approvedAt: APPROVED_AT } });
    expect(result.changes).toEqual({});
    expect(result.warnings).toEqual(['ageGroups: not proposed again — the entries have the values a reviewer approved on 2026-09-30, only their cited text differs']);
  });

  it('proposes a row list with an added, removed or changed row', () => {
    const source = { ageGroups: { approvedAt: APPROVED_AT, excerpt: 'Ages 6 - 10' } };
    const added: ProposedChanges = { ageGroups: { old: [age('Ages 6 - 10', 6, 10)], new: [age('Ages 6 - 10', 6, 10), age('Ages 11 - 13', 11, 13)], excerpt: 'Ages 6 - 10' } };
    const removed: ProposedChanges = { ageGroups: { old: [age('Ages 6 - 10', 6, 10), age('Ages 11 - 13', 11, 13)], new: [age('Ages 6 - 10', 6, 10)], excerpt: 'Ages 6 - 10' } };
    const changed: ProposedChanges = { ageGroups: { old: [age('Ages 6 - 10', 6, 10)], new: [age('Ages 7 - 10', 7, 10)], excerpt: 'Ages 7 - 10' } };
    for (const changes of [added, removed, changed]) {
      expect(Object.keys(withholdDecidedChanges(changes, source).changes)).toEqual(['ageGroups']);
    }
  });

  it('withholds any approved field, an enum list included, when the page text is the text it was approved from', () => {
    const changes: ProposedChanges = { campTypes: { old: ['SCHOOL_BREAK', 'SUMMER_DAY'], new: ['SCHOOL_BREAK'], excerpt: 'Spring Safari' } };
    const source = { campTypes: { approvedAt: APPROVED_AT, excerpt: 'When school is out', contentFingerprint: 'sha256:aaa' } };
    const same = withholdDecidedChanges(changes, source, 'sha256:aaa');
    expect(same.changes).toEqual({});
    expect(same.warnings).toEqual(['campTypes: not proposed again — the page text is unchanged since a reviewer approved this field on 2026-09-30']);
    // A changed page, an unknown fingerprint, or an unapproved field is proposed.
    expect(Object.keys(withholdDecidedChanges(changes, source, 'sha256:bbb').changes)).toEqual(['campTypes']);
    expect(Object.keys(withholdDecidedChanges(changes, source).changes)).toEqual(['campTypes']);
    expect(Object.keys(withholdDecidedChanges(changes, { campTypes: { contentFingerprint: 'sha256:aaa' } }, 'sha256:aaa').changes)).toEqual(['campTypes']);
  });

  it('on a changed page, always proposes an enum list or a folded object: one excerpt cannot vouch for the rest', () => {
    const changes: ProposedChanges = {
      campTypes: { old: ['SUMMER_DAY'], new: ['SUMMER_DAY', 'SLEEPAWAY'], excerpt: 'Day camp' },
      socialLinks: { old: { instagram: 'https://i.example/a' }, new: { instagram: 'https://i.example/a', x: 'https://x.example/a' }, excerpt: '[Instagram](https://i.example/a)' },
    };
    const result = withholdDecidedChanges(changes, {
      campTypes: { approvedAt: APPROVED_AT, excerpt: 'Day camp' },
      socialLinks: { approvedAt: APPROVED_AT, excerpt: '[Instagram](https://i.example/a)' },
    });
    expect(Object.keys(result.changes).sort()).toEqual(['campTypes', 'socialLinks']);
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
