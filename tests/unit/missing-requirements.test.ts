/**
 * The missing-requirements guidance lists every requirement the derivation
 * reports as not verified, in plain words, and the panel renders each one
 * with the camp's website and phone.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { describeMissingRequirements } from '@/lib/admin/missing-requirements';
import { MissingRequirementsPanel, telHref } from '@/components/admin/missing-requirements-panel';

const CAMP_IDS = ['description', 'campType', 'category', 'registrationStatus', 'city', 'websiteUrl', 'ageGroups', 'pricing', 'sessions-verified'];
const SESSION_IDS = ['dates', 'time', 'eligibility', 'registration-status', 'price-options', 'registration-path'];

function rollup(ids: readonly string[], verified: readonly string[] = [], status = 'proposed') {
  return {
    status: status as never,
    requirements: ids.map((id) => ({ id, title: id, status: (verified.includes(id) ? 'verified' : 'proposed') as never })) as never,
  };
}

const SESSION = { id: 'sched-1', label: 'Week 1', startDate: '2027-06-14', endDate: '2027-06-18', startTime: null, endTime: null };

describe('the missing-requirements guidance', () => {
  it('lists every requirement not verified, and nothing that is', () => {
    const guidance = describeMissingRequirements({
      campId: 'camp-1',
      campRollup: rollup(CAMP_IDS, ['category']),
      camp: { description: 'Outdoor science.', city: '', websiteUrl: 'https://larkspur.example.test/', contactPhone: '(555) 010-0199', ageGroups: [], pricing: [{}] },
      sessions: [
        { session: SESSION, rollup: rollup(SESSION_IDS, ['dates', 'registration-path']) },
        { session: { ...SESSION, id: 'sched-2', label: 'Week 2' }, rollup: rollup(SESSION_IDS, SESSION_IDS) },
      ],
    });
    expect(guidance.camp.map((item) => item.requirementId)).toEqual(CAMP_IDS.filter((id) => id !== 'category'));
    expect(guidance.sessions.map((session) => session.scheduleId)).toEqual(['sched-1']);
    expect(guidance.sessions[0]!.missing.map((item) => item.attribute)).toEqual(['time', 'eligibility', 'registration-status', 'price-options']);
    expect(guidance.sessions[0]!.timeEntry).toBe(true);
    // Plain words: empty vs present-but-unchecked, and a list is not entered here.
    const byId = Object.fromEntries(guidance.camp.map((item) => [item.requirementId, item]));
    expect(byId.city!.detail).toContain('No value yet');
    expect(byId.description!.detail).toContain('nobody has checked');
    expect(byId.ageGroups!.entry).toBeUndefined();
    // Camp type and category follow their lists; they are checked through the list, not entered here.
    expect(byId.campType!.entry).toBeUndefined();
    expect(byId.campType!.detail).toContain('camp editor');
    expect(byId.registrationStatus!.entry).toMatchObject({ field: 'registrationStatus', input: 'select' });
    expect(byId['sessions-verified']!.detail).toBe('1 session is not fully checked (listed below).');
    expect(guidance.dataConfidence).toBe('PLACEHOLDER');
  });

  it('renders every listed requirement and session with the source links and the time entry', () => {
    const guidance = describeMissingRequirements({
      campId: 'camp-1',
      campRollup: rollup(CAMP_IDS),
      camp: { websiteUrl: 'https://larkspur.example.test/', contactPhone: '(555) 010-0199' },
      sessions: [{ session: SESSION, rollup: rollup(SESSION_IDS) }],
    });
    const html = renderToStaticMarkup(createElement(MissingRequirementsPanel, { guidance }));
    for (const id of CAMP_IDS) expect(html, id).toContain(`data-testid="missing-${id}"`);
    expect(html).toContain('data-testid="missing-session-sched-1"');
    expect(html).toContain('data-testid="session-time-entry-sched-1"');
    expect(html).toContain('href="https://larkspur.example.test/"');
    expect(html).toContain('href="tel:5550100199"');
    expect(html).toContain('9 requirements still missing');
  });

  it('renders nothing for a VERIFIED camp, and says when no website or phone is on file', () => {
    const verified = describeMissingRequirements({ campId: 'c', campRollup: rollup(CAMP_IDS, CAMP_IDS, 'verified'), camp: {}, sessions: [] });
    expect(verified.camp).toEqual([]);
    expect(renderToStaticMarkup(createElement(MissingRequirementsPanel, { guidance: verified }))).toBe('');

    const bare = describeMissingRequirements({ campId: 'c', campRollup: rollup(['city']), camp: {}, sessions: [] });
    const html = renderToStaticMarkup(createElement(MissingRequirementsPanel, { guidance: bare }));
    expect(html).toContain('No website on file');
    expect(html).toContain('No phone number on file');
  });

  it('lists a requirement that was checked too long ago (stale), saying so', () => {
    const guidance = describeMissingRequirements({
      campId: 'c',
      campRollup: { status: 'stale' as never, requirements: [{ id: 'city', title: 'City', status: 'stale' }, { id: 'pricing', title: 'Pricing', status: 'stale' }] as never },
      camp: { city: 'Golden', pricing: [{}] },
      sessions: [],
    });
    expect(guidance.camp.map((item) => item.requirementId)).toEqual(['city', 'pricing']);
    expect(guidance.camp[0]!.detail).toContain('too long ago');
  });

  it('offers "intentionally empty" for an empty list and never suggests Mark Verified for it', () => {
    const guidance = describeMissingRequirements({ campId: 'c', campRollup: rollup(['ageGroups', 'pricing', 'sessions-verified']), camp: { ageGroups: [], pricing: [] }, sessions: [] });
    expect(guidance.camp.map((item) => item.intentionallyEmpty?.field)).toEqual(['ageGroups', 'pricing', 'schedules']);
    for (const item of guidance.camp) expect(item.detail).not.toMatch(/Mark Verified/);
    const html = renderToStaticMarkup(createElement(MissingRequirementsPanel, { guidance }));
    expect(html).toContain('data-testid="intentionally-empty-pricing-open"');
  });

  it('dials the number without its extension', () => {
    expect(telHref('(555) 010-0199 ext. 12')).toBe('tel:5550100199');
    expect(telHref('555-010-0199 x12')).toBe('tel:5550100199');
    expect(telHref('+1 555 010 0199')).toBe('tel:+15550100199');
  });

  it('says so when the list could not be worked out, instead of showing nothing', () => {
    const html = renderToStaticMarkup(createElement(MissingRequirementsPanel, { guidance: 'unavailable' }));
    expect(html).toContain('data-testid="missing-requirements-unavailable"');
  });
});
