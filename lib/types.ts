export type CampType =
  | "SUMMER_DAY"
  | "SLEEPAWAY"
  | "FAMILY"
  | "VIRTUAL"
  | "WINTER_BREAK"
  | "SCHOOL_BREAK";

export type CampCategory =
  | "SPORTS"
  | "ARTS"
  | "STEM"
  | "NATURE"
  | "ACADEMIC"
  | "MUSIC"
  | "THEATER"
  | "COOKING"
  | "MULTI_ACTIVITY"
  | "OTHER";

export type RegistrationStatus =
  | "OPEN"
  | "FULL"       // at capacity — may open if someone drops
  | "WAITLIST"   // full but accepting waitlist
  | "CLOSED"     // registration period ended
  | "COMING_SOON"
  | "UNKNOWN";

export type DataConfidence = "VERIFIED" | "PLACEHOLDER" | "STALE";

export type PricingUnit =
  | "PER_WEEK"
  | "PER_SESSION"
  | "PER_DAY"
  | "FLAT"
  | "PER_CAMP";

export interface CampAgeGroup {
  id: string;
  label: string;
  minAge: number | null;
  maxAge: number | null;
  minGrade: number | null;
  maxGrade: number | null;
}

export interface CampSchedule {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  earlyDropOff: string | null;
  latePickup: string | null;
}

export interface CampPricing {
  id: string;
  label: string;
  amount: number;
  unit: PricingUnit;
  durationWeeks: number | null;
  ageQualifier: string | null;
  discountNotes: string | null;
}

export interface FieldSource {
  excerpt: string | null;
  sourceUrl: string;
  approvedAt: string; // ISO
}

export interface Camp {
  id: string;
  slug: string;
  name: string;
  description: string;
  notes: string | null;
  campType: CampType;
  category: CampCategory;
  campTypes: CampType[];
  categories: CampCategory[];
  state: string | null;
  zip: string | null;
  websiteUrl: string;
  applicationUrl?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  socialLinks?: Record<string, string> | null;
  interestingDetails: string | null;

  city: string;
  region: string | null;
  communitySlug: string;
  displayName: string;
  neighborhood: string;
  address: string;
  latitude: number | null;
  longitude: number | null;

  lunchIncluded: boolean;

  registrationOpenDate: string | null;
  registrationOpenTime: string | null;
  registrationCloseDate?: string | null;
  registrationStatus: RegistrationStatus;

  dataConfidence: DataConfidence;
  lastVerifiedAt: string | null;
  lastCrawledAt?: string | null;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  sourceUrl: string | null;
  fieldSources?: Record<string, FieldSource> | null;

  organizationName?: string | null;
  providerId?: string | null;

  ageGroups: CampAgeGroup[];
  schedules: CampSchedule[];
  pricing: CampPricing[];
}

export interface Provider {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  domain: string | null;
  logoUrl: string | null;
  address: string | null;
  city: string | null;
  neighborhood: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  applicationUrl?: string | null;
  socialLinks?: Record<string, string> | null;
  notes: string | null;
  crawlRootUrl: string | null;
  communitySlug: string;
  archivedAt?: string | null;
  archivedBy?: string | null;
  archiveReason?: string | null;
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewFlag {
  id: string;
  entityType: 'CAMP' | 'PROVIDER' | 'PERSON';
  entityId: string;
  comment: string;
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  createdBy: string;
  createdAt: string;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
}

export interface FieldAttestation {
  id: string;
  entityType: 'CAMP' | 'PROVIDER' | 'PERSON';
  entityId: string;
  fieldKey: string;
  valueSnapshot?: unknown;
  excerpt?: string | null;
  sourceUrl?: string | null;
  observedAt: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
  status: 'ACTIVE' | 'STALE' | 'INVALIDATED';
  lastRecheckedAt?: string | null;
  invalidatedAt?: string | null;
  invalidationReason?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface AccreditationBody {
  id: string;
  name: string;
  slug: string;
  websiteUrl?: string | null;
  createdAt: string;
}

export interface CampAccreditation {
  id: string;
  campId: string;
  bodyId: string;
  bodyName?: string;
  status: string;
  scope?: string | null;
  sourceUrl?: string | null;
  excerpt?: string | null;
  observedAt: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
  lastVerifiedAt?: string | null;
  expiresAt?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface Person {
  id: string;
  fullName: string;
  slug: string;
  bio?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonContactMethod {
  id: string;
  personId: string;
  type: string;
  value: string;
  label?: string | null;
  createdAt: string;
}

export interface EntityPersonRole {
  id: string;
  personId: string;
  title?: string | null;
  roleType: string;
  notes?: string | null;
  sourceUrl?: string | null;
  excerpt?: string | null;
  observedAt: string;
  approvedAt?: string | null;
  approvedBy?: string | null;
  createdAt: string;
}

export interface AiActionLog {
  id: string;
  capability: 'READ' | 'PROPOSE' | 'WRITE';
  action: string;
  entityType?: 'CAMP' | 'PROVIDER' | 'PERSON' | null;
  entityId?: string | null;
  status: 'REQUESTED' | 'CONFIRMED' | 'REJECTED' | 'COMPLETED' | 'FAILED';
  requestedBy: string;
  confirmedBy?: string | null;
  requiresConfirmation: boolean;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

export interface ProviderWithStats extends Provider {
  campCount: number;
  pendingProposals: number;
  lastCrawledAt: string | null;
  avgConfidence: number | null;
}

export interface Community {
  communitySlug: string;
  displayName: string;
  count: number;
}

export interface SavedCamp {
  id: string;
  campId: string;
  camp: Camp;
  notes: string | null;
  savedAt: string;
  notifyEmail: boolean;
  notifyPush: boolean;
  notifySms: boolean;
}

export interface CampFilters {
  query?: string;
  category?: CampCategory;
  campType?: CampType;
  neighborhood?: string;
  minAge?: number;
  maxAge?: number;
  week?: string;
  maxCost?: number;
  lunchIncluded?: boolean;
  earlyDropOff?: boolean;
}

export const CAMP_TYPE_LABELS: Record<CampType, string> = {
  SUMMER_DAY: "Summer Day Camp",
  SLEEPAWAY: "Sleepaway",
  FAMILY: "Family Camp",
  VIRTUAL: "Virtual",
  WINTER_BREAK: "Winter Break",
  SCHOOL_BREAK: "School Break",
};

export const CAMP_TYPE_DESCRIPTIONS: Record<CampType, string> = {
  SUMMER_DAY: "Drop-off camp during summer. Kids go home each evening.",
  SLEEPAWAY: "Overnight residential camp. Kids stay on-site for the session.",
  FAMILY: "Parents and kids attend together.",
  VIRTUAL: "Fully online — no travel required.",
  WINTER_BREAK: "Runs during winter/holiday school break (Dec–Jan).",
  SCHOOL_BREAK: "Runs during spring break, fall break, or other non-summer school holidays.",
};

export const CATEGORY_LABELS: Record<CampCategory, string> = {
  SPORTS: "Sports",
  ARTS: "Arts & Crafts",
  STEM: "STEM",
  NATURE: "Nature & Outdoors",
  ACADEMIC: "Academic",
  MUSIC: "Music",
  THEATER: "Theater & Drama",
  COOKING: "Cooking",
  MULTI_ACTIVITY: "Multi-Activity",
  OTHER: "Other",
};

export const CATEGORY_COLORS: Record<CampCategory, string> = {
  SPORTS: "bg-terracotta-400 text-white",
  ARTS: "bg-amber-300 text-bark-700",
  STEM: "bg-sky-300 text-bark-700",
  NATURE: "bg-pine-500 text-white",
  ACADEMIC: "bg-bark-400 text-white",
  MUSIC: "bg-purple-500 text-white",
  THEATER: "bg-rose-500 text-white",
  COOKING: "bg-orange-400 text-white",
  MULTI_ACTIVITY: "bg-pine-200 text-pine-700",
  OTHER: "bg-clay-300 text-bark-700",
};

export const STATUS_CONFIG: Record<
  RegistrationStatus,
  { label: string; color: string }
> = {
  OPEN: { label: "Open", color: "bg-emerald-100 text-emerald-800" },
  FULL: { label: "Full", color: "bg-orange-100 text-orange-800" },
  WAITLIST: { label: "Waitlist", color: "bg-amber-100 text-amber-800" },
  CLOSED: { label: "Closed", color: "bg-red-100 text-red-800" },
  COMING_SOON: {
    label: "Coming Soon",
    color: "bg-sky-100 text-sky-800",
  },
  UNKNOWN: { label: "Check Website", color: "bg-gray-100 text-gray-600" },
};

/**
 * Compute the effective registration status at display time.
 * Overrides the stored status based on registrationOpenDate / registrationCloseDate
 * so stale data auto-degrades without waiting for the next crawl.
 *
 * Rules (applied in priority order):
 *  1. If registrationCloseDate is in the past → CLOSED
 *  2. If registrationOpenDate is in the future → COMING_SOON
 *  3. If stored status is COMING_SOON but registrationOpenDate is in the past → OPEN
 *  4. Otherwise return stored status unchanged
 */
export function getEffectiveStatus(
  status: RegistrationStatus,
  registrationOpenDate: string | null,
  registrationCloseDate: string | null,
): RegistrationStatus {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD comparable string
  if (registrationCloseDate && registrationCloseDate < today) return 'CLOSED';
  if (registrationOpenDate && registrationOpenDate > today) return 'COMING_SOON';
  if (status === 'COMING_SOON' && registrationOpenDate && registrationOpenDate <= today) return 'OPEN';
  return status;
}

/** Primary category for display (first element or fall back to singular). */
export function primaryCategory(camp: Camp): CampCategory {
  return camp.categories?.[0] ?? camp.category;
}

/** Primary campType for display (first element or fall back to singular). */
export function primaryCampType(camp: Camp): CampType {
  return camp.campTypes?.[0] ?? camp.campType;
}

export const SUMMER_WEEKS = [
  { label: "Jun 1-5", start: "2026-06-01", end: "2026-06-05" },
  { label: "Jun 8-12", start: "2026-06-08", end: "2026-06-12" },
  { label: "Jun 15-19", start: "2026-06-15", end: "2026-06-19" },
  { label: "Jun 22-26", start: "2026-06-22", end: "2026-06-26" },
  { label: "Jun 29-Jul 3", start: "2026-06-29", end: "2026-07-03" },
  { label: "Jul 6-10", start: "2026-07-06", end: "2026-07-10" },
  { label: "Jul 13-17", start: "2026-07-13", end: "2026-07-17" },
  { label: "Jul 20-24", start: "2026-07-20", end: "2026-07-24" },
  { label: "Jul 27-31", start: "2026-07-27", end: "2026-07-31" },
  { label: "Aug 3-7", start: "2026-08-03", end: "2026-08-07" },
  { label: "Aug 10-14", start: "2026-08-10", end: "2026-08-14" },
  { label: "Aug 17-21", start: "2026-08-17", end: "2026-08-21" },
];

export const NEIGHBORHOODS = [
  "Central Park",
  "City Park",
  "Wash Park",
  "Highlands",
  "Capitol Hill",
  "Cherry Creek",
  "Park Hill",
  "Stapleton",
  "Lakewood",
  "Littleton",
  "Arvada",
  "Boulder",
  "Evergreen",
  "Estes Park",
];
