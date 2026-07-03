# camp.fit Fresh-Eyes Launch Audit — 2026-07-03

Auditor: automated fresh-eyes pass (issue [#49](https://github.com/briananderson1222/campfit/issues/49) / I26).
Target: **live production** https://camp.fit (reachable; home/robots/sitemap/manifest all HTTP 200).
Method: read-only. `curl` for routes/links/SEO/trust text; `tool-playwright` for
browser render, mobile, images, and empty states. No product source modified.
Bar under test: [`docs/launch-readiness-bar.md`](./launch-readiness-bar.md).

## Public pages / page-types inspected (AC2)

| Page type | URL sampled | Render |
|-----------|-------------|--------|
| Home / city picker | `/` | 200, renders |
| City landing | `/c/denver` | 200, 151 camps listed |
| Camp detail | `/c/denver/camps/{apex-music-camp, avid-4-adventure, aerial-cirque-over-denver, champ-camp, cheley-colorado-camps, caresplit-…}` | 200, renders |
| Weekly calendar | `/c/denver/calendar` | 200 |
| Compare | `/c/denver/compare` | 200 (empty state) |
| Auth | `/auth/login` | 200 |
| Machine surfaces | `/robots.txt` `/sitemap.xml` `/manifest.json` `/llms.txt` | 200 |
| Legacy redirects | `/compare` `/calendar` `/dashboard` `/camps/{slug}` | 30x → `/c/denver/...` |
| Unknown camp | `/c/denver/camps/does-not-exist` | 404 (styled) |

Catalog size: **151 camps** in sitemap (`grep -c /camps/ sitemap.xml`).

## Findings by required category (AC2)

### docs-vs-behavior
- **PASS (with note).** `PLAN.md`/`llms.txt` describe a Denver kids-camp directory
  with search/compare/calendar/save — matches live behavior. `llms.txt` claims
  "151 camps"; sitemap confirms 151. No material doc-vs-behavior drift found.
- Note: `llms.txt` implies rich per-camp data ("pricing tiers, age ranges,
  weekly schedules, registration status … direct links"). Present structurally,
  but trust status is `Unverified` sitewide (see F-01) — data is displayed but
  not verified.
- **F-13 (camp-count inconsistency).** Home and city landing advertise **"151 camps"**;
  the calendar page footer reads **"Showing 111 of 111 camps"** — a ~40-camp gap
  with no on-page explanation (likely camps lacking structured weekly-session data
  are silently excluded). Either a bug or a missing "N camps hidden (no schedule)"
  copy.

### dead links / routes
- **F-02 (dead footer links).** Footer "Company" links — **About CampFit**,
  **List Your Camp**, **Privacy Policy** — all point to `href="#"`
  (`components/footer.tsx:44-46`). They go nowhere. Privacy Policy leading
  nowhere is notable before advertising.
- **F-06 (wrong footer target).** Footer "Weekly Calendar" links to `routes.home()`
  instead of the calendar route (`components/footer.tsx:33`).
- **F-07 (stale external camp URLs).** Sampled 12 camp `websiteUrl`s: 9 alive,
  **2 hard 404** (`bounce-gymnastics` → bouncegymnasticsco.com/summer-camp/,
  `bluff-lake-camp` → blufflake.org/camp25) + 1 `403` bot-block (curious-jane).
  ~75-83% alive — below the L1/L3 90% bar. Registration links are the primary
  CTA, so dead ones are high-impact.
- Internal nav links (home, city landing, camp detail) all resolve 2xx. Unknown
  slug returns a proper 404. No internal dead routes found.

### naming consistency
- **PASS (mostly).** Nav/brand ("CampFit", "Camp Fit"), category/type labels, and
  route scheme (`/c/{community}/...`) are consistent.
- **F-08 (cryptic slugs).** Some slugs carry opaque import suffixes:
  `…-1wdc`, `art-on-the-farm-8aft`, `best-kids-camp-aurora-xm51`,
  `adventure-camp-2nd-7th-g070626-1wdc`. Not user-facing text, but they leak into
  URLs and hint at un-cleaned import data.
- **F-14 (confusing duplicate-looking listings).** "Altitude All Sports" appears
  as two cards (Northfield $250/wk vs Denver "Contact for pricing") with identical
  descriptions; "Adventure Camp 2nd-7th" appears as **4 near-identical cards**
  differentiated only by internal session codes (`#G070626-1WDC`, `#G071326-1WDC`,
  …). A first-time visitor cannot tell these apart from duplicates/broken entries.

### half-finished pages
- **F-02** (above) — footer sections stubbed to `#`.
- **F-10** (below) — a live `** VERIFY **` editorial placeholder on a camp card.
- No lorem/"coming soon"/TODO text found (`grep -iE 'lorem|todo|coming soon'` → 0),
  but the `** VERIFY **` marker (F-10) slipped past that pattern — the bar's C1 grep
  was tightened to catch editorial markers.

### copy quality
- **F-10 (literal editorial placeholder LIVE — top slop finding).** The "Dream Big"
  camp card on `/c/denver` renders an internal review marker in the age-group
  field, visible to parents and present in the Next.js data payload (raw data,
  not a render glitch):
  `** VERIFY ** Pre-K Kinder & 1st grades 2nd - 5th grades 6th-8th grades 9th - 11th grades`
  (independently confirmed: `curl /c/denver | grep '** VERIFY **'`). A `** VERIFY **`
  editorial marker shipped to production is the clearest disqualifying-slop case.
- **F-03 (data-slop camp name).** A live camp is titled:
  `Caresplit enrichment camps @ home - Now Grasshopper Kids, see that row.`
  — a spreadsheet/scrape import artifact (stray instruction "see that row.",
  "@ home - Now"). Renders in `<h1>` and `<title>`.
- **F-11 (duplicated body copy).** Apex Music Camp prints its sibling-discount
  sentence **twice verbatim, back-to-back**: *"For every additional sibling/friend
  who attends the camp we will honor a $25 discount to the total amount paid."* ×2.
- **F-04 (truncated meta descriptions).** Camp detail `<meta description>` slices
  `description.slice(0,120)` mid-word and concatenates awkwardly:
  - apex-music: `"…geared towards children between Starting at $319. Located in Northglen, Denver."`
    — broken ("between Starting at") + likely typo ("Northglen" vs "Northglenn").
  - avid-4-adventure: `"…at Camp Blue Sky  For ages 6–18. Starting at $1,349."`
    — double space + missing sentence boundary. Affects search/social snippets sitewide.
- **F-12 (inconsistent description copy).** Three near-duplicate site descriptions
  drift across `<meta description>`, `og:description`, and `manifest.json.description`
  for the same pages (Home/Login) — pick one canonical string.

## SEO fundamentals
- **F-05 (site-wide duplicated title suffix).** **Every** page renders
  `… | CampFit | CampFit`. Root cause: `app/layout.tsx` title template `"%s | CampFit"`
  plus per-page titles that already end in `| CampFit`. Verified on 5 page types.
  Sitewide SEO defect.
- **F-09 (no og:image).** No `og:image` on home or camp pages (`openGraph` has no
  `images`). Social shares render a text-only card.
- **PASS:** canonical URLs present per page; meta description present; viewport +
  theme-color present; `robots.txt` disallows `/dashboard`,`/auth/`,`/api/` and
  points to sitemap; sitemap URL count (151) matches catalog.
- Minor: viewport sets `maximum-scale=1` (disables pinch-zoom — WCAG 1.4.4 nit).
- **F-17 (login page has no dedicated title/description).** `/auth/login` inherits
  the generic homepage fallback title `CampFit — Find Kids Camps in Your City` and a
  mismatched fallback description — no page-specific metadata.

## Data-trust honesty (measured; fixes are #48/I21)
- **F-01 (near-zero verified coverage) — the central launch gate.** Every camp
  sampled (5/5 spot-checks + flagship) renders **"Unverified — check camp website"**.
  No live page showed "Verified". The site is **honest** (unverified data is
  clearly labeled unverified — bar item **T1 PASS**, **T2 PASS**: no live
  "Verified (source pending)"), but the **verified-coverage metric (T3)** appears
  to be at or near **0%**. This is precisely why "ready to advertise" is gated:
  the catalog is displayed but not verified.
- Latent risk for #48: code path `dataConfidence === "VERIFIED"` without
  `lastVerifiedAt` renders `"Verified (source pending)"` — no live occurrence
  today, but it would present "Verified" without a source. Flag for #48/I21.

## Empty / error states
- **E1 PASS.** `/c/denver/compare` empty state is helpful (screenshot-verified):
  icon + *"No camps to compare"* + *"Browse camps and click 'Compare' to add them
  here"* + a "Browse Camps" CTA. Not a blank/broken screen.
- **E2 PASS.** Partial-data empty state is also good: Apex Music Camp shows
  *"Weekly schedule not yet available — check the camp website for dates."* instead
  of a blank table. (Filters apply client-side — SSR returns all 151 regardless of
  `?category=&campType=` — so zero-result was verified in-browser, not via curl.)
- 404: unknown camp slug returns a styled 404 page (not a soft 200).

## Mobile / PWA & images (tool-playwright, 390×844 emulation)
- **M1 PASS.** No horizontal overflow on home, listing, or camp detail
  (`document.scrollWidth === window.innerWidth` on all three). Nothing cut off;
  hamburger nav present (36×36px).
- **M2 PASS.** `/manifest.json` complete: name, short_name, start_url `/`,
  display `standalone`, theme_color `#1B4332`, background_color `#FEFCF3`,
  icons 192 + 512 (`any maskable`). Icon assets return 200.
- **I1 PASS.** **Zero broken images** on every page audited — because there are
  **zero `<img>` elements at all**. No camp photography anywhere: not a broken-image
  bug, but a notable content gap for a discovery product (F-15).
- **F-16 (missing favicon / apple-touch-icon).** `GET /favicon.ico` → **404** and
  no `<link rel="icon">` in `<head>`; `GET /apple-touch-icon.png` → **404** with no
  `<link rel="apple-touch-icon">`. Browser tab has no favicon; iOS home-screen icon
  relies solely on maskable manifest icons. (Independently confirmed via curl.)
- **Minor (M-nit).** Filter chips / several buttons render 32–36px tall, under the
  44×44px recommended tap-target minimum. Mobile listing search placeholder is
  visually crowded by the adjacent filter icon.
- **F-15 (no photography).** Content gap: parents typically expect camp photos;
  the site is entirely text/SVG-icon based. Not a launch blocker per the bar, logged
  for the backlog.

---

## Gate Evaluation — bar item → pass/fail at audit time (AC4)

| Bar item | Status | Evidence |
|----------|--------|----------|
| T1 no unverified shown as verified | **PASS** | 5/5 camps show "Unverified — check camp website"; none "Verified". |
| T2 no "Verified" without source | **PASS** | grep of live camp pages: 0 "Verified (source pending)". Latent code path noted for #48. |
| T3 verified-coverage ≥ TBD% | **BLOCKED (owner) / likely FAIL** | Sampled coverage ≈ 0% verified; threshold unset. F-01. |
| C1 no placeholder/editorial text | **FAIL** | F-10 `** VERIFY **` live on "Dream Big" card (confirmed via curl). |
| C2 no import-artifact camp names | **FAIL** | F-03 "…see that row." |
| C3 non-empty descriptions | **NOT VERIFIED** | needs DB count; spot-checks had descriptions (some templated/duplicated — F-11). |
| L1 internal links resolve | **PASS** | all internal hrefs 2xx; 404 for unknown slug. |
| L2 unknown slug → 404 | **PASS** | `/c/denver/camps/does-not-exist` → 404 styled. |
| L3 external links alive (≥90%) | **FAIL** | F-07: 9/12 alive (2×404). |
| I1 no broken images | **PASS** | 0 broken images (0 `<img>` total; photography gap F-15). |
| I2 PWA/icon/favicon assets load | **FAIL** | icons 192/512 + manifest 200, but `/favicon.ico` + `/apple-touch-icon.png` → 404 (F-16). |
| M1 no mobile overflow @390px | **PASS** | scrollWidth==innerWidth on home/listing/detail. |
| M2 valid installable manifest | **PASS** | manifest complete. |
| M3 viewport + theme-color | **PASS** | both present (maximum-scale nit). |
| E1 compare empty state | **PASS** | helpful empty state (screenshot-verified). |
| E2 zero-result empty state | **PASS** | partial-data & filter empty states are helpful. |
| S1 unique/clean titles | **FAIL** | F-05 `\| CampFit \| CampFit` sitewide. |
| S2 description + canonical | **PASS (w/ F-04)** | present; descriptions truncated awkwardly. |
| S3 robots + sitemap correct | **PASS** | valid; 151 URLs; correct disallows. |
| S4 og:image present | **FAIL** | F-09 no og:image. |

**Gate result at 2026-07-03: NOT PASSING.** Failing items: **C1, C2, L3, I2, S1, S4**,
plus **T3** blocked on owner threshold (and effectively failing at ~0% verified
coverage). Honesty of the trust display (T1/T2 PASS) and the empty states / mobile
layout (E1/E2/M1–M3) are genuine strengths.

---

## Prioritized findings → follow-on issue titles (AC3)

Each is independently actionable and read-only-audit-derived. Suggested severity
in brackets.

1. `[HIGH] Remove live "** VERIFY **" editorial placeholder from "Dream Big" age-groups + add an import guard rejecting editorial-marker text`
2. `[HIGH] Verified-coverage is ~0%: define + reach the T3 verified-camp threshold before advertising (I20/I21)`
3. `[HIGH] Fix site-wide duplicate page title suffix "| CampFit | CampFit" (layout template + per-page suffix both append)`
4. `[HIGH] Remove import-slop camp record "Caresplit … see that row." and add a sanity check for scraper-artifact camp names`
5. `[HIGH] Footer "Privacy Policy"/"About CampFit"/"List Your Camp" link to href="#": ship pages or remove the links before launch`
6. `[MEDIUM] Repair stale external camp registration URLs (dead-link sweep of all 151 websiteUrls; e.g. bounce-gymnastics, bluff-lake-camp 404)`
7. `[MEDIUM] Fix truncated/awkward camp meta descriptions ("…children between Starting at $319"; "…Blue Sky  For ages") and audit "Northglen" typo`
8. `[MEDIUM] Resolve camp-count inconsistency: "151 camps" vs calendar "Showing 111 of 111" (explain or fix the ~40 excluded)`
9. `[MEDIUM] Add og:image for home + camp detail social share cards`
10. `[MEDIUM] Add favicon.ico + apple-touch-icon (both currently 404) and rel=icon/apple-touch-icon links`
11. `[MEDIUM] De-duplicate confusing listings (Altitude All Sports ×2; Adventure Camp ×4 by session code) or group multi-session camps`
12. `[LOW] Remove duplicated sibling-discount sentence on Apex Music Camp (printed twice verbatim)`
13. `[LOW] Point footer "Weekly Calendar" link at the calendar route, not home`
14. `[LOW] Clean opaque camp slugs (…-1wdc, -8aft, -xm51, g070626) from imported data`
15. `[LOW] Canonicalize the 3 drifting site-description strings (meta/og/manifest) and give /auth/login its own title`
16. `[LOW] Remove maximum-scale=1 from viewport to restore pinch-zoom (WCAG 1.4.4); enlarge sub-44px tap targets`

## Honest gaps in this audit
- Verified-coverage % (T3) and empty-description count (C3) need a DB query the
  owner runs; audit inferred from spot-checks, not a full-catalog count.
- External-link liveness sampled 12/151; `403`s may be bot-blocks not true deaths.
- Copy read for "AI-slop" beyond obvious import artifacts is judgment-adjacent;
  the bar restricts C2 to objectively-detectable artifacts to stay finite.
- T1/T2 (no unverified-shown-as-verified) were checked on ~7 of 151 camps
  (all showed "Unverified"). A scripted pass over all 151 detail pages for any bare
  "Verified"/"Verified (source pending)" string is the definitive check and is
  listed as an owner/follow-on step, not completed here.
- Browser findings (M1/I1/E1/E2/F-10/F-13/F-14/F-16) come from tool-playwright;
  screenshots were saved to the session scratchpad but are ephemeral (not committed).
