/**
 * tests/integration/aggregators-view.test.ts — unit coverage for
 * `app/admin/aggregators/aggregators-view.ts`'s pure formatting/payload
 * helpers (campfit#93 Wave 3, Task 3.2).
 *
 * Pure functions, no React/DOM/network — run under the shared
 * `vitest.config.ts` (`environment: "node"`) alongside the rest of
 * `tests/integration/**`.
 */
import { describe, expect, it } from 'vitest';

import {
  statusBadge,
  tosGateBadge,
  isTosApproved,
  relativeDate,
  emptyRegisterFormState,
  canSubmitRegisterForm,
  buildRegisterPayload,
  type RegisterAggregatorFormState,
} from '@/app/admin/aggregators/aggregators-view';

describe('statusBadge', () => {
  it('REGISTERED -> amber "Registered"', () => {
    expect(statusBadge('REGISTERED')).toEqual({ label: 'Registered', className: expect.stringContaining('amber') });
  });
  it('ACTIVE -> pine "Active"', () => {
    expect(statusBadge('ACTIVE')).toEqual({ label: 'Active', className: expect.stringContaining('pine') });
  });
  it('DECLINED -> red "Declined"', () => {
    expect(statusBadge('DECLINED')).toEqual({ label: 'Declined', className: expect.stringContaining('red') });
  });
});

describe('tosGateBadge (R1/AC1 — the fetch gate readout)', () => {
  it('null -> attention-grabbing "ToS review required" (never a passive blank)', () => {
    const badge = tosGateBadge(null);
    expect(badge.label).toBe('ToS review required');
    expect(badge.className).toContain('amber');
  });

  it('APPROVED -> "ToS Approved"', () => {
    expect(tosGateBadge('APPROVED').label).toBe('ToS Approved');
  });

  it('DECLINED -> "ToS Declined"', () => {
    expect(tosGateBadge('DECLINED').label).toBe('ToS Declined');
  });
});

describe('isTosApproved', () => {
  it('is true only for APPROVED', () => {
    expect(isTosApproved('APPROVED')).toBe(true);
    expect(isTosApproved('DECLINED')).toBe(false);
    expect(isTosApproved(null)).toBe(false);
  });
});

describe('relativeDate', () => {
  it('reports "Never" for null/undefined', () => {
    expect(relativeDate(null)).toBe('Never');
    expect(relativeDate(undefined)).toBe('Never');
  });

  it('accepts a Date object directly (pg driver\'s raw timestamptz parse)', () => {
    expect(relativeDate(new Date())).toBe('Today');
  });

  it('accepts an ISO string too', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(relativeDate(yesterday)).toBe('Yesterday');
  });
});

describe('emptyRegisterFormState / canSubmitRegisterForm', () => {
  it('defaults maxPages/maxDepth to "20"/"2" and communitySlug to the provided default', () => {
    const state = emptyRegisterFormState('denver');
    expect(state).toEqual({ name: '', url: '', communitySlug: 'denver', maxPages: '20', maxDepth: '2' });
  });

  it('cannot submit with an empty name/url', () => {
    const state = emptyRegisterFormState('denver');
    expect(canSubmitRegisterForm(state, () => true)).toBe(false);
  });

  it('cannot submit when the injected URL validator rejects the URL', () => {
    const state: RegisterAggregatorFormState = { ...emptyRegisterFormState('denver'), name: 'Acme', url: 'not-a-url' };
    expect(canSubmitRegisterForm(state, () => false)).toBe(false);
  });

  it('can submit once name + a validator-approved url are present', () => {
    const state: RegisterAggregatorFormState = { ...emptyRegisterFormState('denver'), name: 'Acme', url: 'https://acme.example' };
    expect(canSubmitRegisterForm(state, () => true)).toBe(true);
  });
});

describe('buildRegisterPayload', () => {
  it('trims name/url and falls back to the default community when blank', () => {
    const state: RegisterAggregatorFormState = {
      name: '  Acme Aggregator  ',
      url: '  https://acme.example  ',
      communitySlug: '  ',
      maxPages: '20',
      maxDepth: '2',
    };
    expect(buildRegisterPayload(state, 'denver')).toEqual({
      name: 'Acme Aggregator',
      url: 'https://acme.example',
      communitySlug: 'denver',
      maxPages: 20,
      maxDepth: 2,
    });
  });

  it('clamps a blank/non-numeric maxPages/maxDepth to the repository defaults (20/2)', () => {
    const state: RegisterAggregatorFormState = {
      name: 'Acme', url: 'https://acme.example', communitySlug: 'denver', maxPages: '', maxDepth: 'abc',
    };
    const payload = buildRegisterPayload(state, 'denver');
    expect(payload.maxPages).toBe(20);
    expect(payload.maxDepth).toBe(2);
  });

  it('clamps a zero/negative maxPages/maxDepth to the defaults too', () => {
    const state: RegisterAggregatorFormState = {
      name: 'Acme', url: 'https://acme.example', communitySlug: 'denver', maxPages: '0', maxDepth: '-3',
    };
    const payload = buildRegisterPayload(state, 'denver');
    expect(payload.maxPages).toBe(20);
    expect(payload.maxDepth).toBe(2);
  });

  it('preserves a valid custom maxPages/maxDepth', () => {
    const state: RegisterAggregatorFormState = {
      name: 'Acme', url: 'https://acme.example', communitySlug: 'boulder', maxPages: '5', maxDepth: '1',
    };
    expect(buildRegisterPayload(state, 'denver')).toEqual({
      name: 'Acme', url: 'https://acme.example', communitySlug: 'boulder', maxPages: 5, maxDepth: 1,
    });
  });
});
