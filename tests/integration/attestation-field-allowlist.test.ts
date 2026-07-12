import { describe, expect, it } from 'vitest';
import { isAllowedAttestationField } from '@/lib/admin/entity-admin-repository';

describe('attestation field allowlist parity', () => {
  it('allows exact fields and only the three CAMP indexed collections', () => {
    expect(isAllowedAttestationField('CAMP', 'name')).toBe(true);
    expect(isAllowedAttestationField('CAMP', 'ageGroups:0')).toBe(true);
    expect(isAllowedAttestationField('CAMP', 'schedules:id')).toBe(true);
    expect(isAllowedAttestationField('CAMP', 'pricing:0')).toBe(true);
  });

  it('rejects suffix broadening and malformed nested suffixes', () => {
    expect(isAllowedAttestationField('CAMP', 'name:anything')).toBe(false);
    expect(isAllowedAttestationField('PROVIDER', 'name:anything')).toBe(false);
    expect(isAllowedAttestationField('PERSON', 'bio:anything')).toBe(false);
    expect(isAllowedAttestationField('CAMP', 'pricing:0:extra')).toBe(false);
  });
});
