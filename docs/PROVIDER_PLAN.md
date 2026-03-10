# Provider Entity — Migration Plan

## Problem Statement

Denver Botanic Gardens runs 12+ distinct camp programs. Each is a separate `Camp` record (correct
— parents compare individual programs), but they share an organization, a website, a location, and
crawl behavior. Today we track `organizationName TEXT` on `Camp`, but that's a loose string with no
enforcement, no rollup, and no place to put org-level data.

An admin's mental model is also "provider-first": they think about Denver Botanic Gardens, then its
camps. A per-provider admin view is more valuable than a flat camp list.

---

## Target Data Model

```
Provider
  id                TEXT PK
  name              TEXT NOT NULL          -- "Denver Botanic Gardens"
  slug              TEXT UNIQUE            -- "denver-botanic-gardens"
  websiteUrl        TEXT                   -- "https://botanicgardens.org"
  domain            TEXT                   -- "botanicgardens.org" (derived, indexed)
  logoUrl           TEXT NULL
  address           TEXT NULL              -- shared physical address if all camps same location
  city              TEXT NULL
  neighborhood      TEXT NULL
  contactEmail      TEXT NULL
  contactPhone      TEXT NULL
  notes             TEXT NULL              -- admin-only internal notes
  crawlRootUrl      TEXT NULL              -- entry point for discovery crawl (may differ from websiteUrl)
  communitySlug     TEXT NOT NULL          -- which community this provider belongs to
  createdAt         TIMESTAMPTZ
  updatedAt         TIMESTAMPTZ

Camp
  ... (existing fields)
  providerId        TEXT NULL FK → Provider(id)  -- replaces organizationName
  organizationName  TEXT NULL                    -- kept for backwards compat, removed after migration
```

`CrawlSiteHint` already has `domain TEXT` — it naturally correlates with `Provider.domain`. In the
Provider admin view, hints for that provider's domain are shown inline (same component as today's
camp data page, just mounted at the provider level).

---

## DB Migration (two-phase, zero-downtime)

### Phase 1 — Add Provider table, backfill, dual-write

```sql
-- 1. Create Provider table
CREATE TABLE "Provider" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  "websiteUrl"  TEXT,
  domain        TEXT,
  "logoUrl"     TEXT,
  address       TEXT,
  city          TEXT,
  neighborhood  TEXT,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  notes         TEXT,
  "crawlRootUrl" TEXT,
  "communitySlug" TEXT NOT NULL DEFAULT 'denver',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "Provider_domain_idx" ON "Provider"(domain);
CREATE INDEX "Provider_communitySlug_idx" ON "Provider"("communitySlug");

-- 2. Add providerId to Camp (nullable)
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "providerId" TEXT REFERENCES "Provider"(id) ON DELETE SET NULL;
CREATE INDEX "Camp_providerId_idx" ON "Camp"("providerId");

-- 3. Backfill: create a Provider row for each distinct organizationName
-- (run as a migration script, not raw SQL in production — see scripts/backfill-providers.mjs)
```

**Backfill script** (`scripts/backfill-providers.mjs`):
```js
// For each distinct organizationName, create a Provider and link camps
const orgs = await pool.query(
  `SELECT DISTINCT "organizationName", "websiteUrl", city, neighborhood, "communitySlug"
   FROM "Camp" WHERE "organizationName" IS NOT NULL`
);
for (const org of orgs.rows) {
  const slug = org.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const domain = org.websiteUrl ? new URL(org.websiteUrl).hostname.replace(/^www\./, '') : null;
  const { rows: [provider] } = await pool.query(
    `INSERT INTO "Provider" (name, slug, "websiteUrl", domain, city, neighborhood, "communitySlug")
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [org.organizationName, slug, org.websiteUrl, domain, org.city, org.neighborhood, org.communitySlug]
  );
  await pool.query(
    `UPDATE "Camp" SET "providerId" = $1 WHERE "organizationName" = $2`,
    [provider.id, org.organizationName]
  );
}
```

### Phase 2 — Remove organizationName (after UI migration complete)

```sql
ALTER TABLE "Camp" DROP COLUMN "organizationName";
```

Keep `organizationName` alive for at least 2 weeks after the UI fully reads from `Provider` —
gives time to verify and rollback if needed.

---

## UI Changes

### 1. Admin Sidebar — add "Providers" nav item

```
/admin                   Dashboard
/admin/review            Review Queue  (pending badge)
/admin/crawls            Crawl Monitor
/admin/providers         Providers          ← NEW
/admin/camps             Camp Data
/admin/users             Users
```

### 2. `/admin/providers` — Provider List

**Layout:** Table with columns: Name | Domain | Camp Count | Pending Reviews | Last Crawled | Actions

**Each row shows:**
- Provider name (link to `/admin/providers/[providerId]`)
- Domain (with external link)
- `n camps` badge
- Amber badge if any camps have pending proposals
- `Last crawled: Mar 5` from most recent CrawlRun that touched any of their camps
- Actions: Edit | View all camps | Trigger crawl

**Value:** The admin can see at a glance "Denver Botanic Gardens has 12 camps, 3 pending reviews, last crawled Feb 28" — more actionable than the flat camp list.

### 3. `/admin/providers/[providerId]` — Provider Detail Page

This is the key new page. Layout:

```
┌─ Provider header ─────────────────────────────────────────────┐
│  Denver Botanic Gardens                  [Edit] [Trigger Crawl]│
│  botanicgardens.org  ·  Denver  ·  12 camps                    │
└────────────────────────────────────────────────────────────────┘

┌─ Rollup stats (server-rendered) ──────────────────────────────┐
│  12 camps   3 with open registration   2 pending review        │
│  Last crawled: Mar 5, 2026  ·  Avg confidence: 84%             │
└────────────────────────────────────────────────────────────────┘

┌─ Pending proposals ───────────────────────────────────────────┐
│  (same amber banner as camp editor, but for ALL camps)         │
│  ↳ Fairy Garden Camp — 3 changes — Review →                   │
│  ↳ Pollinators & Bugs — 2 changes — Review →                  │
└────────────────────────────────────────────────────────────────┘

┌─ Crawl Hints (domain-scoped) ─────────────────────────────────┐
│  (same SiteHintsSection component as camp data page)           │
│  Hints here apply to ALL camps from this provider's domain     │
└────────────────────────────────────────────────────────────────┘

┌─ Provider Info (inline editable) ─────────────────────────────┐
│  Name · Website · Logo URL · Address · Contact Email/Phone     │
│  Notes · Community · Crawl Root URL                            │
└────────────────────────────────────────────────────────────────┘

┌─ Camps from this provider ────────────────────────────────────┐
│  Compact table: Name | Category | Reg Status | Last Verified  │
│  Each row links to /admin/camps/[campId]                       │
│  "Add camp" button → creates new Camp with providerId set      │
└────────────────────────────────────────────────────────────────┘
```

**Why this view is more valuable than per-camp:** The admin can:
- Update crawl hints once and they affect all 12 Botanic Gardens camps
- See which camps are stale and need a crawl
- Trigger a targeted crawl of just this provider's camps
- Understand registration status across all programs at a glance (some FULL, some OPEN)
- Add a new camp for a new program they discover

### 4. Camp Data Page Updates

When a camp has a `providerId`:
- Header shows provider name as a clickable link: `Denver Botanic Gardens ↗`
- The "Crawl Hints" section shows a note: "Hints are managed at the provider level" with link to
  `/admin/providers/[providerId]` rather than duplicating the hints UI
- Camp editor gains a "Provider" field (select from existing providers or create new)

When a camp has no `providerId` (standalone camp, no org affiliation):
- Camp page shows the `SiteHintsSection` directly (as today)
- "Organization" field is a text input (for camps that don't warrant a full Provider record)

### 5. Review Panel Updates

When reviewing a proposal, if the camp has a provider:
- The "Add Crawl Hint" section links to the provider page instead of saving inline
- Shows: "Hints for this domain are managed via Denver Botanic Gardens (provider) → Add hint"
- This avoids duplicating hint management in two places

---

## Crawl Pipeline Changes

### Current: per-camp crawl
```
for each camp: fetch URL → extract → diff → propose
```

### New: provider-aware crawl (Phase 2)

Add `--provider [providerId]` flag to `run-crawl.mjs`:
```
node scripts/run-crawl.mjs --provider xyz  # crawl all camps for this provider
```

This crawls all camps where `providerId = xyz` ordered by `lastVerifiedAt ASC` — efficient for
"recrawl all Botanic Gardens camps."

### Future: Discovery crawl mode

For providers with a `crawlRootUrl`, a separate discovery pass:
1. Fetch `crawlRootUrl`
2. Ask LLM: "List all distinct camp programs on this page with their names and URLs"
3. For each discovered program: look up existing Camp by URL or name, create if new
4. Queue each for the normal extraction crawl

This fully automates "one business → many camps" without manual intervention.

---

## Public-Facing Changes

Minimal for Phase 1, but unlocks:

- "More camps from Denver Botanic Gardens" section on camp detail page
  → query `Camp WHERE providerId = $provider AND id != $thisCamp`
- Provider filter on the explore page (optional — some parents care about org reputation)
- Provider page for SEO: `/c/denver/providers/denver-botanic-gardens` listing all their programs

---

## Implementation Order

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 1 | DB migration Phase 1 (Provider table + providerId on Camp) | 1h | Non-breaking |
| 2 | Backfill script | 1h | Run once, verify |
| 3 | `/admin/providers` list page | 2h | Server component + table |
| 4 | `/admin/providers/[id]` detail page | 4h | Rollup stats + hints + camps table |
| 5 | Camp editor: provider field (select) | 1h | Add to EditableField |
| 6 | Review panel: link to provider for hints | 30min | Small change |
| 7 | Provider API CRUD routes | 2h | GET/POST/PATCH |
| 8 | Public "more from this provider" section | 2h | Camp detail page |
| 9 | DB migration Phase 2 (drop organizationName) | 15min | After 2 weeks |
| 10 | Crawl --provider flag | 1h | run-crawl.mjs arg |
| 11 | Discovery crawl mode | 4h | Future, complex |

Total for items 1–8: ~14h of focused work.

---

## Open Questions

1. **Community scoping**: Does a Provider belong to one community (Denver) or can it span
   communities? Denver Botanic Gardens only has Denver camps, but a chain like KidStrong might
   operate in multiple communities. Recommendation: `Provider.communitySlug` is nullable or
   multi-value. Start with single community, revisit.

2. **Camp with no provider**: Some camps are genuinely standalone (a parent who runs one camp from
   their home). Keep `organizationName` as a free-text fallback, OR treat single-camp orgs as
   Providers too. Leaning toward: always create a Provider even for solo camps — keeps the model
   consistent, and the "provider" for a solo camp is just that camp's name.

3. **Logo/branding**: Provider logos would significantly improve the public-facing camp cards. Worth
   adding a `logoUrl` and displaying it on camp cards for visual recognition.

4. **Trigger crawl from provider page**: Admin triggers a crawl of all camps for a provider. This
   needs a server action or API endpoint that creates a CrawlRun scoped to `campIds` for that
   provider. The UI button on the provider detail page POSTs to `/api/admin/crawl/trigger` with
   `{ providerIds: [id] }`.
