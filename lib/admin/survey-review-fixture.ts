import type { CampChangeProposal } from './types';

export const surveyReviewFixtureProposal: CampChangeProposal = {
  id: 'survey-fixture-1',
  campId: 'camp-maple-arts',
  crawlRunId: 'crawl-fixture-2026-06',
  createdAt: '2026-06-08T15:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  status: 'PENDING',
  sourceUrl: 'https://maplearts.example/summer-camps',
  rawExtraction: {
    model: 'campfit-crawler-fixture',
    source: 'publisher camp page',
  },
  proposedChanges: {
    ageRange: {
      old: 'Ages 8-10',
      new: 'Ages 7-12',
      confidence: 0.94,
      excerpt: 'Summer studio camp welcomes campers ages 7-12 in June and July.',
      sourceUrl: 'https://maplearts.example/summer-camps#ages',
      mode: 'update',
    },
    sessions: {
      old: ['July 8-12'],
      new: ['June 17-21', 'July 8-12'],
      confidence: 0.88,
      excerpt: 'June 17-21 and July 8-12 sessions are open for registration.',
      sourceUrl: 'https://maplearts.example/summer-camps#sessions',
      mode: 'add_items',
    },
    // registrationStatus carries a typed enum descriptor (schema vocab is
    // uppercase OPEN/FULL/WAITLIST/CLOSED/COMING_SOON/UNKNOWN). The proposed
    // value 'Waitlist' is INTENTIONALLY non-canonical (mixed-case) so it does
    // NOT conform to that vocab — this exercises survey 1.13.0 typed-value
    // gating: `use-proposed` is blocked until the reviewer corrects it to a
    // declared value (e.g. 'WAITLIST'). See survey-review-fixture.spec.ts.
    registrationStatus: {
      old: 'Open',
      new: 'Waitlist',
      confidence: 0.81,
      excerpt: 'Registration is currently waitlist only for the June session.',
      sourceUrl: 'https://maplearts.example/summer-camps#registration',
      mode: 'update',
    },
  },
  overallConfidence: 0.88,
  extractionModel: 'campfit-crawler-fixture',
  reviewerNotes: null,
  feedbackTags: ['schedule-delta', 'eligibility-impact', 'registration-risk'],
  priority: 0,
  // registrationStatus is left UNapplied so it renders as an undecided, typed
  // enum review field (its non-canonical 'Waitlist' value exercises typed-value
  // gating). The fixture page already passes includeAppliedFields:true, so this
  // is safe for all consumers; keeping it out of appliedFields also makes it a
  // genuinely pending review field rather than one shown as already-applied.
  appliedFields: [],
  campName: 'Maple Arts Studio Camp',
  campSlug: 'maple-arts-studio-camp',
  communitySlug: 'denver',
  providerId: 'provider-maple-arts',
  lastVerifiedAt: '2026-05-20T12:00:00.000Z',
  campData: {
    ageRange: 'Ages 8-10',
    sessions: ['July 8-12'],
    registrationStatus: 'Open',
  },
  fieldTimeline: {
    ageRange: {
      lastUpdatedAt: '2026-05-20T12:00:00.000Z',
      lastAttestedAt: '2026-05-20T12:00:00.000Z',
    },
    sessions: {
      lastUpdatedAt: '2026-05-20T12:00:00.000Z',
      lastAttestedAt: null,
    },
    registrationStatus: {
      lastUpdatedAt: '2026-06-01T12:00:00.000Z',
      lastAttestedAt: '2026-06-01T12:00:00.000Z',
    },
  },
  crawlStartedAt: '2026-06-08T14:55:00.000Z',
  crawlCompletedAt: '2026-06-08T15:00:00.000Z',
  crawlTrigger: 'MANUAL',
  crawlTriggeredBy: 'campfit-fixture',
};
