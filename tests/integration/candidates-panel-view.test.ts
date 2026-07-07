/**
 * tests/integration/candidates-panel-view.test.ts — unit coverage for
 * `app/admin/aggregators/[id]/candidates-panel-view.ts`'s pure dedupe/
 * provenance/onboard-readout helpers (campfit#93 Wave 4, Task 4.2).
 *
 * Pure functions, no React/DOM/network — run under the shared
 * `vitest.config.ts` (`environment: "node"`).
 */
import { describe, expect, it } from 'vitest';

import {
  dedupeBadge,
  dedupeBadgeClassName,
  truncateExcerpt,
  snapshotSourceHref,
  onboardResultCopy,
  classifyCandidatesLoad,
  classifyOnboardResponse,
  type AggregatorCandidateRow,
  type OnboardResultRow,
} from '@/app/admin/aggregators/[id]/candidates-panel-view';

describe('dedupeBadge — reflects the persisted classify verdict (R3/AC3)', () => {
  it('"New" when no possibleDuplicateOfProviderId is set', () => {
    const badge = dedupeBadge({ possibleDuplicateOfProviderId: null, possibleDuplicateOfName: null, duplicateReason: null });
    expect(badge).toEqual({ label: 'New', tone: 'new', tooltip: null });
  });

  it('"Possible duplicate of X" with duplicateReason as the tooltip when set (near-duplicate)', () => {
    const badge = dedupeBadge({
      possibleDuplicateOfProviderId: 'prov-1',
      possibleDuplicateOfName: 'Acme Camps',
      duplicateReason: 'name 85% similar to "Acme Camps"',
    });
    expect(badge).toEqual({
      label: 'Possible duplicate of Acme Camps',
      tone: 'duplicate',
      tooltip: 'name 85% similar to "Acme Camps"',
    });
  });

  it('falls back to a generic label when possibleDuplicateOfName is missing but the id is set', () => {
    const badge = dedupeBadge({ possibleDuplicateOfProviderId: 'prov-1', possibleDuplicateOfName: null, duplicateReason: null });
    expect(badge.label).toBe('Possible duplicate of an existing provider');
    expect(badge.tone).toBe('duplicate');
  });
});

describe('dedupeBadgeClassName', () => {
  it('duplicate tone -> amber, new tone -> pine', () => {
    expect(dedupeBadgeClassName('duplicate')).toContain('amber');
    expect(dedupeBadgeClassName('new')).toContain('pine');
  });
});

describe('truncateExcerpt', () => {
  it('returns null for a null excerpt', () => {
    expect(truncateExcerpt(null)).toBeNull();
  });

  it('returns the excerpt unchanged when under the max length', () => {
    expect(truncateExcerpt('Short excerpt.', 180)).toBe('Short excerpt.');
  });

  it('truncates a long excerpt at a word boundary and appends an ellipsis', () => {
    const long = 'This camp offers weekday morning and afternoon sessions for kids ages 5 through 12 with optional extended care.';
    const result = truncateExcerpt(long, 40);
    expect(result!.length).toBeLessThanOrEqual(41);
    expect(result!.endsWith('…')).toBe(true);
    expect(result!.endsWith(' …')).toBe(false);
  });
});

describe('snapshotSourceHref', () => {
  it('null for a null/empty snapshotSourceRef', () => {
    expect(snapshotSourceHref(null)).toBeNull();
    expect(snapshotSourceHref('  ')).toBeNull();
  });

  it('passes through a non-empty ref', () => {
    expect(snapshotSourceHref('https://aggregator.example/page-1')).toBe('https://aggregator.example/page-1');
  });
});

describe('onboardResultCopy (R4/AC4)', () => {
  it('created -> links to ?created=1 (lands on the unmodified FirstCrawlOffer)', () => {
    const result: OnboardResultRow = { candidateId: 'c1', status: 'created', providerId: 'p1', providerSlug: 'acme', providerCreated: true };
    const copy = onboardResultCopy(result);
    expect(copy.href).toBe('/admin/providers/p1?created=1');
    expect(copy.linkLabel).toBe('View & run first crawl →');
  });

  it('existing -> links WITHOUT ?created=1 (matches provider-new-form.tsx\'s existing-duplicate UX)', () => {
    const result: OnboardResultRow = { candidateId: 'c1', status: 'existing', providerId: 'p1', providerSlug: 'acme', providerCreated: false };
    const copy = onboardResultCopy(result);
    expect(copy.href).toBe('/admin/providers/p1');
    expect(copy.linkLabel).toBe('Already onboarded — open it →');
  });

  it('error -> no href, message carries the error text', () => {
    const result: OnboardResultRow = { candidateId: 'c1', status: 'error', error: 'Candidate is not PENDING' };
    const copy = onboardResultCopy(result);
    expect(copy.href).toBeNull();
    expect(copy.linkLabel).toBeNull();
    expect(copy.message).toBe('Candidate is not PENDING');
  });

  it('error with no message -> a generic fallback', () => {
    const copy = onboardResultCopy({ candidateId: 'c1', status: 'error' });
    expect(copy.message).toBe('Failed to onboard this candidate.');
  });
});

describe('classifyCandidatesLoad (mirrors classifyScheduleLoad\'s HIGH-finding discipline)', () => {
  const rows: AggregatorCandidateRow[] = [
    {
      id: 'c1', name: 'Acme Camp', websiteUrl: 'https://acme.example', locale: 'Denver',
      possibleDuplicateOfProviderId: null, possibleDuplicateOfName: null, duplicateReason: null,
      provenanceExcerpt: 'Acme Camp offers...', provenanceLocator: 'chars:0-20', snapshotSourceRef: 'https://aggregator.example/page-1',
    },
  ];

  it('ok: classifies a 2xx array body as ready candidates', () => {
    expect(classifyCandidatesLoad({ kind: 'ok', body: rows })).toEqual({ status: 'ready', candidates: rows });
  });

  it('ok: a non-array success body is treated as a malformed response, not a crash', () => {
    expect(classifyCandidatesLoad({ kind: 'ok', body: { unexpected: true } })).toEqual({
      status: 'error', message: 'Failed to load candidates (unexpected response shape)',
    });
  });

  it('non-ok: uses the body\'s own {error} message', () => {
    expect(classifyCandidatesLoad({ kind: 'http-error', status: 403, body: { error: 'Forbidden' } })).toEqual({
      status: 'error', message: 'Forbidden',
    });
  });

  it('non-ok: falls back to a status-coded message when the error body has no {error} string', () => {
    expect(classifyCandidatesLoad({ kind: 'http-error', status: 500, body: null })).toEqual({
      status: 'error', message: 'Failed to load candidates (status 500)',
    });
  });

  it('reject: a network-level fetch rejection is a reachable error state', () => {
    expect(classifyCandidatesLoad({ kind: 'network-error' })).toEqual({
      status: 'error', message: 'Failed to load candidates',
    });
  });
});

describe('classifyOnboardResponse', () => {
  const results: OnboardResultRow[] = [
    { candidateId: 'c1', status: 'created', providerId: 'p1', providerSlug: 'acme', providerCreated: true },
    { candidateId: 'c2', status: 'existing', providerId: 'p2', providerSlug: 'beta', providerCreated: false },
  ];

  it('ok: classifies a 2xx {results} body as ready', () => {
    expect(classifyOnboardResponse({ kind: 'ok', body: { results } })).toEqual({ status: 'ready', results });
  });

  it('ok: a body without a {results} array is treated as malformed, not a crash', () => {
    expect(classifyOnboardResponse({ kind: 'ok', body: {} })).toEqual({
      status: 'error', message: 'Failed to onboard selected candidates (unexpected response shape)',
    });
  });

  it('non-ok: uses the body\'s own {error} message', () => {
    expect(classifyOnboardResponse({ kind: 'http-error', status: 400, body: { error: 'candidateIds required' } })).toEqual({
      status: 'error', message: 'candidateIds required',
    });
  });

  it('reject: a network-level fetch rejection is a reachable error state', () => {
    expect(classifyOnboardResponse({ kind: 'network-error' })).toEqual({
      status: 'error', message: 'Failed to onboard selected candidates',
    });
  });
});
