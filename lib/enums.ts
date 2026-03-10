export const CAMP_TYPE_OPTIONS = [
  { value: 'SUMMER_DAY',   label: 'Summer Day' },
  { value: 'SLEEPAWAY',    label: 'Sleepaway' },
  { value: 'FAMILY',       label: 'Family' },
  { value: 'VIRTUAL',      label: 'Virtual' },
  { value: 'WINTER_BREAK', label: 'Winter Break' },
  { value: 'SCHOOL_BREAK', label: 'School Break' },
] as const;

export const CAMP_CATEGORY_OPTIONS = [
  { value: 'SPORTS',        label: 'Sports' },
  { value: 'ARTS',          label: 'Arts' },
  { value: 'STEM',          label: 'STEM' },
  { value: 'NATURE',        label: 'Nature' },
  { value: 'ACADEMIC',      label: 'Academic' },
  { value: 'MUSIC',         label: 'Music' },
  { value: 'THEATER',       label: 'Theater' },
  { value: 'COOKING',       label: 'Cooking' },
  { value: 'MULTI_ACTIVITY', label: 'Multi-Activity' },
  { value: 'OTHER',         label: 'Other' },
] as const;

export const REGISTRATION_STATUS_OPTIONS = [
  { value: 'OPEN',        label: 'Open' },
  { value: 'FULL',        label: 'Full' },        // at capacity, may open if someone drops
  { value: 'WAITLIST',    label: 'Waitlist' },    // full but accepting waitlist entries
  { value: 'CLOSED',      label: 'Closed' },      // registration period ended or not yet open
  { value: 'COMING_SOON', label: 'Coming Soon' },
  { value: 'UNKNOWN',     label: 'Unknown' },
] as const;

export const DATA_CONFIDENCE_OPTIONS = [
  { value: 'VERIFIED',    label: 'Verified' },
  { value: 'PLACEHOLDER', label: 'Placeholder' },
  { value: 'STALE',       label: 'Stale' },
] as const;

export type CampType = typeof CAMP_TYPE_OPTIONS[number]['value'];
export type CampCategory = typeof CAMP_CATEGORY_OPTIONS[number]['value'];
export type RegistrationStatus = typeof REGISTRATION_STATUS_OPTIONS[number]['value'];
export type DataConfidence = typeof DATA_CONFIDENCE_OPTIONS[number]['value'];

/** Fields that must use a select dropdown instead of free text */
export const ENUM_OPTIONS: Record<string, readonly { value: string; label: string }[]> = {
  campType:           CAMP_TYPE_OPTIONS,
  category:           CAMP_CATEGORY_OPTIONS,
  registrationStatus: REGISTRATION_STATUS_OPTIONS,
  dataConfidence:     DATA_CONFIDENCE_OPTIONS,
};

export function labelFor(field: string, value: string): string {
  const opts = ENUM_OPTIONS[field];
  return opts?.find(o => o.value === value)?.label ?? value;
}
