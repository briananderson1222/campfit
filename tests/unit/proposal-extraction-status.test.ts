import { describe, expect, it } from 'vitest';

import { reportedOverallConfidence, storedExtractionIncompleteness } from '@/lib/admin/proposal-extraction-status';

describe('proposal extraction status', () => {
  it('does not show the 0 ordering key as a reported confidence', () => {
    expect(reportedOverallConfidence({ overallConfidence: 0, proposedChanges: { city: { old: 'a', new: 'b' } } })).toBeNull();
    expect(reportedOverallConfidence({ overallConfidence: 0.7, proposedChanges: { city: { old: 'a', new: 'b', confidence: 0.7 } } })).toBe(0.7);
  });

  it('reads the stored incomplete marker and ignores malformed or absent ones', () => {
    expect(storedExtractionIncompleteness({ incomplete: { reason: 'content-truncated', coverage: [{ status: 'complete' }, { status: 'unread' }] } }))
      .toEqual({ reason: 'content-truncated', unreadRanges: 1 });
    expect(storedExtractionIncompleteness({ via: 'traverse' })).toBeNull();
    expect(storedExtractionIncompleteness({ incomplete: { reason: 7 } })).toBeNull();
    expect(storedExtractionIncompleteness(null)).toBeNull();
  });
});
