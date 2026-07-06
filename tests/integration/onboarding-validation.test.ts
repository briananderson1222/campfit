/**
 * tests/integration/onboarding-validation.test.ts — pure-function tests for
 * `lib/admin/onboarding-validation.ts` (campfit#90 Wave 1). No database
 * connection needed — importing this module only evaluates its function
 * declarations, following `editable-fields.test.ts`'s precedent for
 * DB-free `tests/integration/` files.
 */
import { describe, expect, it } from 'vitest';

import { isValidHttpUrl, parseDomain } from '@/lib/admin/onboarding-validation';

describe('isValidHttpUrl', () => {
  it('accepts http(s) URLs, including ones with paths/query strings', () => {
    expect(isValidHttpUrl('http://example.com')).toBe(true);
    expect(isValidHttpUrl('https://example.com')).toBe(true);
    expect(isValidHttpUrl('https://example.com/path/to/page?query=1')).toBe(true);
    expect(isValidHttpUrl('https://www.example.com')).toBe(true);
  });

  it('rejects non-URLs, ftp://, and bare hostnames', () => {
    expect(isValidHttpUrl('not a url')).toBe(false);
    expect(isValidHttpUrl('ftp://example.com')).toBe(false);
    expect(isValidHttpUrl('example.com')).toBe(false);
  });

  it('treats null/undefined/empty string as "not provided" (valid)', () => {
    expect(isValidHttpUrl(null)).toBe(true);
    expect(isValidHttpUrl(undefined)).toBe(true);
    expect(isValidHttpUrl('')).toBe(true);
  });
});

describe('parseDomain', () => {
  it('strips a leading www. and lowercases the hostname', () => {
    expect(parseDomain('https://www.Example.com')).toBe('example.com');
    expect(parseDomain('https://example.com')).toBe('example.com');
  });

  it('ignores paths/query strings when extracting the hostname', () => {
    expect(parseDomain('https://example.com/programs/summer?x=1')).toBe('example.com');
  });

  it('returns null for an invalid string or a missing value', () => {
    expect(parseDomain('not a url')).toBeNull();
    expect(parseDomain(null)).toBeNull();
    expect(parseDomain(undefined)).toBeNull();
  });

  it('does not strip non-www subdomains (accepted, preexisting limitation)', () => {
    expect(parseDomain('https://shop.example.com')).toBe('shop.example.com');
  });
});
