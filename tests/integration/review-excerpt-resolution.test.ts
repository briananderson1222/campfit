import { describe, expect, it } from 'vitest';
import { parseCharsLocator, resolveReviewExcerpt } from '@/lib/admin/review-excerpt-resolution';

describe('Evidence resolution both-polarity', () => {
  it('resolves an exact locator and computes a locator for one occurrence', () => {
    expect(parseCharsLocator('chars:2-6')).toEqual({ start: 2, end: 6 });
    expect(resolveReviewExcerpt('camp', 'a camp here', 'chars:2-6')).toEqual({
      state: 'verified', resolvedExcerpt: 'camp', locator: 'chars:2-6',
    });
    expect(resolveReviewExcerpt('camp', 'a camp here')).toMatchObject({ state: 'verified', locator: 'chars:2-6' });
  });

  it('fails closed for mismatch, malformed bounds, missing body, and an ambiguous locator-free repeat', () => {
    expect(resolveReviewExcerpt('camp', 'a changed page', 'chars:2-6').state).toBe('approximate_stale');
    expect(resolveReviewExcerpt('camp', 'camp camp').state).toBe('approximate_stale');
    expect(resolveReviewExcerpt('camp', 'camp camp', 'chars:5-9')).toMatchObject({ state: 'verified', locator: 'chars:5-9' });
    expect(resolveReviewExcerpt('camp', undefined).state).toBe('unavailable');
    expect(parseCharsLocator('field:name')).toBeUndefined();
  });
});
