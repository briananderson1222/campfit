# CampScout — Denver Kids Camp Discovery Platform

## Vision
A PWA for Denver parents to discover, compare, save, and get notified about kids' camps. Seeded from curated CSV data, architected for automated web scraping and multi-city expansion.

## Business Model: Freemium for Parents

### Free Tier
- Browse & search all camps
- Basic filters (age, category, camp type)
- Camp detail pages
- Save up to 5 camps

### Premium (~$5-10/month via Stripe)
- Unlimited saves
- All notification channels (email + push + SMS)
- Registration-opens alerts
- "New camps matching your preferences" alerts
- Pre-camp-start reminders
- Calendar export (Google Calendar / .ics)
- Advanced filters (early drop-off, lunch included, cost range, neighborhood)

---

## Data Model

### Camp (core entity)
```
Camp {
  id            UUID
  slug          string (unique, URL-friendly)
  name          string
  description   text
  notes         text
  campType      enum: SUMMER_DAY | SLEEPAWAY | FAMILY | VIRTUAL | WINTER_BREAK | SCHOOL_BREAK
  category      enum: SPORTS | ARTS | STEM | NATURE | ACADEMIC | MUSIC | THEATER | COOKING | MULTI_ACTIVITY | OTHER
  websiteUrl    string
  interestingDetails  text

  // Location
  city          string (default: "Denver")
  region        string (nullable — for future multi-city)
  neighborhood  string (e.g., "Central Park", "Wash Park")
  address       string
  latitude      float (nullable — geocoded at seed/ingest time)
  longitude     float (nullable)

  // Hours & Logistics
  lunchIncluded bool

  // Registration
  registrationOpenDate   date (nullable)
  registrationOpenTime   time (nullable)
  registrationStatus     enum: OPEN | CLOSED | WAITLIST | COMING_SOON | UNKNOWN

  // Data provenance
  sourceType    enum: CSV | SCRAPER | MANUAL | PROVIDER_FORM
  sourceUrl     string (nullable — scraper target URL)
  lastVerifiedAt datetime
  dataConfidence enum: VERIFIED | PLACEHOLDER | STALE

  createdAt     datetime
  updatedAt     datetime
}
```

### CampAgeGroup (many-to-one → Camp)
Normalizes the messy age data (PreK, "6 to teen", "ages 4-12", grade ranges).
```
CampAgeGroup {
  id        UUID
  campId    UUID → Camp
  label     string    (display text: "PreK", "K", "1st-2nd Grades", "6 to teen")
  minAge    int (nullable)
  maxAge    int (nullable)
  minGrade  int (nullable, 0=K, -1=PreK)
  maxGrade  int (nullable)
}
```

### CampSchedule (many-to-one → Camp)
Handles the complex session structure: AM/PM half-days, full-day, multi-week.
```
CampSchedule {
  id           UUID
  campId       UUID → Camp
  label        string   ("Morning Session", "Full Day", "Week of June 1-5")
  startDate    date
  endDate      date
  startTime    time (nullable — e.g., 9:00 AM)
  endTime      time (nullable — e.g., 3:00 PM)
  earlyDropOff time (nullable — e.g., 8:00 AM)
  latePickup   time (nullable — e.g., 5:30 PM)
}
```

### CampPricing (many-to-one → Camp)
Handles varied pricing: per-week, per-session, tiered by duration, tiered by age.
```
CampPricing {
  id            UUID
  campId        UUID → Camp
  label         string  ("Per Week", "AM Session", "1-Week Stay", "2-Week Bundle")
  amount        decimal
  unit          enum: PER_WEEK | PER_SESSION | PER_DAY | FLAT | PER_CAMP
  durationWeeks int (nullable — for multi-week pricing: 1, 2, 3)
  ageQualifier  string (nullable — "8 year olds", "9-17 year olds")
  discountNotes text (nullable — "Sibling discount available", "10% early bird")
}
```

### User
```
User {
  id            UUID
  email         string (unique)
  name          string
  authProvider  enum: EMAIL | GOOGLE
  tier          enum: FREE | PREMIUM
  stripeCustomerId  string (nullable)
  stripeSubscriptionId string (nullable)

  // Notification preferences
  notifyEmail    bool (default: true)
  notifyPush     bool (default: false)
  notifySms      bool (default: false)
  phoneNumber    string (nullable)

  // Parent profile (for "match my preferences" alerts)
  childAgeMin    int (nullable)
  childAgeMax    int (nullable)
  preferredNeighborhoods  string[] (nullable)
  preferredCategories     enum[] (nullable)

  createdAt     datetime
  updatedAt     datetime
}
```

### SavedCamp (many-to-many: User ↔ Camp)
```
SavedCamp {
  id        UUID
  userId    UUID → User
  campId    UUID → Camp
  notes     text (nullable — personal notes)
  savedAt   datetime
}
```

### Notification
```
Notification {
  id           UUID
  userId       UUID → User
  campId       UUID → Camp (nullable)
  type         enum: REGISTRATION_OPENS | CAMP_APPROACHING | NEW_CAMP_MATCH
  channel      enum: EMAIL | PUSH | SMS
  title        string
  body         text
  scheduledFor datetime
  sentAt       datetime (nullable)
  status       enum: PENDING | SENT | FAILED
  createdAt    datetime
}
```

### PushSubscription (for Web Push API)
```
PushSubscription {
  id           UUID
  userId       UUID → User
  endpoint     string
  p256dh       string
  auth         string
  createdAt    datetime
}
```

### DataSource (Phase 4 — scraping infrastructure)
```
DataSource {
  id          UUID
  name        string ("Aerial Cirque Over Denver", "Denver Parks & Rec")
  type        enum: SCRAPER | GOOGLE_SHEET | CSV | PROVIDER_FORM
  targetUrl   string
  schedule    string (cron expression)
  parserConfig jsonb (scraper-specific config)
  lastRunAt   datetime (nullable)
  lastStatus  enum: SUCCESS | FAILED | PARTIAL
  campCount   int (how many camps this source provides)
}
```

---

## Key Abstractions

### 1. CampRepository
```typescript
interface CampRepository {
  findAll(filters: CampFilters): Promise<PaginatedResult<Camp>>
  findBySlug(slug: string): Promise<Camp | null>
  findByWeek(weekStart: Date): Promise<Camp[]>
  search(query: string, filters?: CampFilters): Promise<Camp[]>
  upsert(camp: CampInput): Promise<Camp>  // idempotent — key for ingestion
}
```

### 2. DataIngestionAdapter
```typescript
interface DataIngestionAdapter {
  readonly sourceType: SourceType
  fetch(): Promise<RawCampData[]>              // get raw data
  normalize(raw: RawCampData): CampInput       // transform to unified schema
  ingest(): Promise<IngestionResult>           // fetch + normalize + upsert
}

// Implementations:
// - CsvIngestionAdapter (Phase 1 — seed from CSV files)
// - ScraperIngestionAdapter (Phase 4 — per-site web scrapers)
// - GoogleSheetAdapter (future — community spreadsheet sync)
// - ProviderFormAdapter (future — camp providers submit via form)
```

### 3. NotificationService
```typescript
interface NotificationService {
  scheduleRegistrationAlert(userId: string, campId: string): Promise<void>
  scheduleCampReminder(userId: string, campId: string, daysBefore: number): Promise<void>
  checkNewCampMatches(userId: string): Promise<void>
  processScheduledNotifications(): Promise<void>  // cron job
}

interface NotificationChannel {
  send(to: string, title: string, body: string): Promise<void>
}
// Implementations: EmailChannel (Resend), SmsChannel (Twilio), PushChannel (Web Push)
```

### 4. SearchService
```typescript
interface SearchService {
  search(query: string, filters: CampFilters): Promise<SearchResult<Camp>>
  suggest(partial: string): Promise<string[]>  // autocomplete
}

// Phase 1: PostgresSearchService (pg full-text search + tsvector)
// Phase N: AlgoliaSearchService or MeilisearchService (if needed)
```

### 5. SubscriptionService
```typescript
interface SubscriptionService {
  createCheckoutSession(userId: string): Promise<string>  // Stripe URL
  handleWebhook(event: StripeEvent): Promise<void>
  getUserTier(userId: string): Promise<'FREE' | 'PREMIUM'>
  enforceLimit(userId: string, feature: string): Promise<boolean>
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Vercel (Edge)                   │
│  ┌─────────────────────────────────────────────┐ │
│  │           Next.js App (PWA)                 │ │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────┐ │ │
│  │  │ Public   │  │ Auth'd   │  │ API Routes│ │ │
│  │  │ Pages    │  │ Dashboard│  │ /api/*    │ │ │
│  │  │ - Home   │  │ - Saved  │  │ - camps   │ │ │
│  │  │ - Search │  │ - Prefs  │  │ - users   │ │ │
│  │  │ - Detail │  │ - Billing│  │ - notify  │ │ │
│  │  └──────────┘  └──────────┘  │ - webhook │ │ │
│  │                              └───────────┘ │ │
│  └─────────────────────────────────────────────┘ │
│          │              │             │           │
│  ┌───────▼──────────────▼─────────────▼────────┐ │
│  │          Service Layer (lib/)               │ │
│  │  CampRepository  SearchService              │ │
│  │  NotificationService  SubscriptionService   │ │
│  │  DataIngestionAdapter                       │ │
│  └──────────────────┬──────────────────────────┘ │
└─────────────────────┼───────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌──────────┐
   │Supabase │  │ Stripe  │  │ Resend / │
   │ - Postgres│ │ Billing │  │ Twilio   │
   │ - Auth   │  └─────────┘  └──────────┘
   │ - Storage│
   │ - Edge Fn│ ← cron: notification processor
   └─────────┘
```

---

## PWA Requirements

- `next-pwa` or `@serwist/next` for service worker generation
- Web App Manifest (name, icons, theme color, display: standalone)
- Offline caching strategy: cache camp listing data for offline browsing
- Web Push API integration via PushSubscription model
- Install prompt UX on mobile

---

## Project Structure

```
camp/
├── app/                          # Next.js App Router
│   ├── (public)/
│   │   ├── page.tsx              # Home — featured camps + search
│   │   ├── search/page.tsx       # Search results with filters
│   │   ├── camps/[slug]/page.tsx # Camp detail page
│   │   └── calendar/page.tsx     # Weekly availability view
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   ├── dashboard/page.tsx    # Saved camps
│   │   └── settings/page.tsx     # Notification prefs, billing
│   ├── api/
│   │   ├── camps/route.ts
│   │   ├── saved-camps/route.ts
│   │   ├── notifications/route.ts
│   │   ├── push/subscribe/route.ts
│   │   └── webhooks/stripe/route.ts
│   ├── manifest.ts               # PWA manifest
│   └── layout.tsx
├── components/
│   ├── camp-card.tsx
│   ├── camp-filters.tsx
│   ├── week-calendar.tsx
│   ├── search-bar.tsx
│   ├── save-button.tsx
│   └── install-prompt.tsx        # PWA install banner
├── lib/
│   ├── repositories/
│   │   └── camp-repository.ts
│   ├── services/
│   │   ├── search-service.ts
│   │   ├── notification-service.ts
│   │   └── subscription-service.ts
│   ├── ingestion/
│   │   ├── adapter.ts            # DataIngestionAdapter interface
│   │   ├── csv-adapter.ts        # CSV parser + normalizer
│   │   └── normalizers.ts        # Price parsing, age parsing, etc.
│   ├── supabase/
│   │   ├── client.ts
│   │   └── middleware.ts
│   └── utils/
│       ├── price-parser.ts       # "$300/week per session" → structured pricing
│       └── age-parser.ts         # "6 to teen", "PreK", "ages 4-12" → age range
├── prisma/
│   └── schema.prisma
├── scripts/
│   ├── seed.ts                   # CSV → DB seeder
│   └── geocode.ts                # Batch geocode camp addresses
├── public/
│   ├── icons/                    # PWA icons
│   └── sw.js                     # Service worker (generated)
├── data/                         # CSV source files
│   └── *.csv
└── scrapers/                     # Phase 4
    ├── base-scraper.ts
    └── sites/
        └── *.ts                  # Per-site scraper implementations
```

---

## Implementation Phases

### Phase 1 — Foundation & Data (Weeks 1-3)
1. Initialize Next.js project with Tailwind + shadcn/ui
2. Define Prisma schema (all models above)
3. Build CSV normalizer:
   - Price parser (handles "$300/week per session", tiered pricing, etc.)
   - Age parser (handles "PreK", "6 to teen", "ages 4-12", grade ranges)
   - Schedule parser (week columns → CampSchedule records)
   - Category classifier
4. Seed script: CSV → normalized → Supabase
5. CampRepository with Prisma
6. Home page: featured/all camps grid
7. Search page: full-text search + filters (age, category, type, neighborhood)
8. Camp detail page: all info, link to register
9. PWA setup (manifest, service worker, install prompt)

### Phase 2 — User Accounts & Saves (Weeks 4-5)
1. Supabase Auth (email + Google OAuth)
2. User profile + child age preferences
3. Save/favorite camps (with 5-camp limit for free tier)
4. Dashboard: view saved camps

### Phase 3 — Notifications & Premium (Weeks 6-8)
1. Stripe integration (checkout, webhooks, tier enforcement)
2. Premium gate on features (unlimited saves, advanced filters, notifications)
3. Email notifications via Resend (registration-opens alerts)
4. Web Push notifications (service worker + PushSubscription)
5. SMS via Twilio
6. Notification scheduler (Vercel Cron or Supabase Edge Function)
7. "New camps matching your preferences" matching engine

### Phase 4 — Dynamic Data Pipeline (Weeks 9-12)
1. DataIngestionAdapter interface
2. Base scraper with Playwright
3. First 5-10 camp site scrapers
4. Nightly cron job: scrape → normalize → upsert → diff report
5. Data confidence tracking (VERIFIED / PLACEHOLDER / STALE)
6. Admin review workflow via Supabase Studio

### Phase 5 — Enhanced UX (Ongoing)
1. Weekly calendar view (interactive, filterable)
2. Map view (geocoded camps on a map)
3. Camp comparison tool
4. Calendar export (.ics / Google Calendar)
5. SEO optimization (structured data, meta tags, sitemap)

---

## CSV Normalization Challenges (Known Issues)

These require special attention in the CSV adapter:

| Challenge | Example | Strategy |
|-----------|---------|----------|
| Inconsistent pricing | "$300/week per session (am/pm)" vs "$1349 for one week, $2399 for two weeks" | Regex-based price parser → multiple CampPricing records |
| Ambiguous ages | "6 to teen" vs "PreK" vs "ages 4-12" vs "1st-12th grade" | Age parser maps to {minAge, maxAge, minGrade, maxGrade} |
| Placeholder data | "Blue = 2025 info" flag in CSV header | Set dataConfidence = PLACEHOLDER, filter/flag in UI |
| Multi-value cells | Week columns with Y/N across 11+ columns | Iterate columns, create CampSchedule per available week |
| Missing data | Many camps missing hours, registration dates | Nullable fields, UI shows "Contact camp for details" |
| HTML/special chars | Emoji in names, URLs with special chars | Sanitize during normalization |
| Camp type inference | Main CSV = summer, separate files = other types | Derive campType from source file name |

---

## Tech Stack Summary

| Layer | Choice | Reason |
|-------|--------|--------|
| Framework | Next.js 14 (App Router) | SSR/SEO, PWA support, Vercel-native |
| Styling | Tailwind CSS + shadcn/ui | Fast, accessible, consistent |
| Database | Supabase (PostgreSQL) | Hosted Postgres, built-in auth, free tier |
| ORM | Prisma | Type-safe, migrations, great DX |
| Auth | Supabase Auth | Google OAuth + email, row-level security |
| Payments | Stripe | Industry standard, good Next.js integration |
| Email | Resend | Modern API, generous free tier |
| SMS | Twilio | Reliable, well-documented |
| Push | Web Push API | Free, no third-party dependency |
| PWA | @serwist/next | Service worker generation for Next.js |
| Hosting | Vercel + Supabase | Ship fast, scale later |
| Scraping (P4) | Playwright | Handles JS-rendered camp websites |
| Search | Postgres full-text (→ Meilisearch if needed) | Start simple, upgrade path exists |
