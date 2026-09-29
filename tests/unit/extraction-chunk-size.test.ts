import { describe, expect, it } from 'vitest';

import { DEFAULT_EXTRACTION_CHUNK_SIZE, resolveExtractionChunkSize } from '@/lib/ingestion/traverse-pipeline';

describe('TRAVERSE_CHUNK_SIZE', () => {
  it("defaults to Traverse's own chunk size", () => {
    expect(DEFAULT_EXTRACTION_CHUNK_SIZE).toBe(12_000);
    expect(resolveExtractionChunkSize({})).toBe(12_000);
    expect(resolveExtractionChunkSize({ TRAVERSE_CHUNK_SIZE: ' ' })).toBe(12_000);
  });

  it('accepts an integer inside the bounds and refuses anything else', () => {
    expect(resolveExtractionChunkSize({ TRAVERSE_CHUNK_SIZE: '6000' })).toBe(6_000);
    expect(resolveExtractionChunkSize({ TRAVERSE_CHUNK_SIZE: '1000' })).toBe(1_000);
    expect(resolveExtractionChunkSize({ TRAVERSE_CHUNK_SIZE: '32000' })).toBe(32_000);
    for (const bad of ['999', '32001', '6000.5', 'six thousand', '-1']) {
      expect(() => resolveExtractionChunkSize({ TRAVERSE_CHUNK_SIZE: bad })).toThrow(/TRAVERSE_CHUNK_SIZE/);
    }
  });
});
