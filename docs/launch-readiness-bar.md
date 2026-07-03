# camp.fit Launch-Readiness Bar

Status: **DRAFT — pending owner sign-off** (see "Owner Sign-Off").
Owner: Brian Anderson. Idea: **I26** (camp.fit desloppification / launch gates).
Related issue: [#49](https://github.com/briananderson1222/campfit/issues/49).

## Purpose

This is the **finite, measurable** definition of "ready to advertise camp.fit."
It converts "I'm afraid there isn't enough polish" into a gate decision backed by
evidence. Every item below is **objectively checkable** — a command to run, a page
to open, or a count to compare against a threshold. A reviewer can determine
pass/fail for each item **without judgment calls**.

Rules (binding):

- **Finite.** This bar is a fixed list, not a moving target. Adding items is an
  owner decision, recorded here with a date.
- **No gold-plating.** If an item is not on this list, it does not gate launch.
- **Evidence-gated.** "Ready to advertise" == every non-deferred item passes and
  the owner has signed off.
- **Scope.** camp.fit public surface only (home, city landing, camp detail,
  calendar, compare, auth). Admin (`/admin/*`) and API internals are out of scope.

Public page types in scope (the audit must cover each):
`/` (city picker) · `/c/{community}` (city landing) ·
`/c/{community}/camps/{slug}` (camp detail) · `/c/{community}/calendar` ·
`/c/{community}/compare` · `/auth/login` (+ signup/forgot/update-password) ·
machine surfaces `/robots.txt`, `/sitemap.xml`, `/manifest.json`, `/llms.txt`.

---

## The Bar

Legend for "How to check": `cmd` = shell/curl command, `page` = open URL,
`count` = compare a count to a threshold.

### A. Data-trust honesty
> Fixing the trust display is issue **#48 / I21**'s job. This bar only **measures**
> it — it must not present unverified data as verified.

| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **T1** | No unverified/stale camp is labeled "Verified". | page: open 10 camp detail pages incl. some `dataConfidence != VERIFIED`; read the trust badge/line. | Every camp with `dataConfidence` in {PLACEHOLDER, STALE} shows an "Unverified"/"check camp website" signal; none shows "Verified". |
| **T2** | "Verified" is never shown without a real freshness/source anchor. | page/cmd: grep rendered camp pages for the string `Verified (source pending)` (or any "Verified" with no date/source). | Zero occurrences of "Verified" lacking a date or source. (Currently FAILS — tracked to #48.) |
| **T3** | Verified-coverage metric — **OWNER DECISION (threshold TBD)**. | cmd: owner-run query — `% of published camps with dataConfidence=VERIFIED AND lastVerifiedAt set`. | Coverage >= **TBD%** (owner sets the number; I20 verified-coverage threshold). Placeholder until owner fills in. |

### B. Copy quality / no slop
| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **C1** | No placeholder / lorem / TODO / editorial-marker text on public pages. | cmd: `curl` each in-scope page, `grep -iE 'lorem|lipsum|\bTODO\b|\bFIXME\b|\bXXX\b|coming soon|\*\* ?VERIFY|\bVERIFY \*\*'` (exclude the search input `placeholder=` attr). | Zero matches in visible copy. |
| **C2** | No AI-slop or import-artifact text in camp names/descriptions. | cmd: scan camp names/slugs for stray instructions, dangling punctuation, "@ home - Now", "see that row", doubled words. | Zero camp names read as scraped/spreadsheet garbage. |
| **C3** | Every camp detail page has a non-empty, human-readable description. | count: camps where description is empty/whitespace. | 0 empty descriptions (or each such camp shows an explicit "no description yet" empty state, not a blank block). |

### C. Dead links / routes
| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **L1** | All internal links/routes resolve (no 404/5xx) on in-scope pages. | cmd: extract `href="/..."` from home, city landing, one camp page; `curl -sSL -o /dev/null -w '%{http_code}'` each. | All internal links return 2xx (redirects allowed only to a 2xx target). |
| **L2** | Unknown camp slug returns a proper 404 (not a blank/soft page). | cmd: `curl -sSL -w '%{http_code}' /c/denver/camps/does-not-exist`. | HTTP 404 with a styled not-found page. |
| **L3** | Sampled external camp `websiteUrl` links are alive. | cmd: sample 20 camp `websiteUrl`s; HEAD each. | >= 90% of sampled external links return 2xx/3xx; dead ones become follow-on data fixes. |

### D. Broken images
| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **I1** | No broken images on in-scope pages. | page (browser): for each in-scope page, count `<img>` with `naturalWidth === 0`. | 0 broken images. |
| **I2** | PWA/OG/icon assets load, incl. favicon. | cmd: HEAD `/icons/icon-192.png`, `/icons/icon-512.png`, `/manifest.json`, `/favicon.ico`, `/apple-touch-icon.png`; check OG image if declared. | All referenced icon/manifest/favicon assets return 200. |

### E. Mobile / PWA basics
| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **M1** | No horizontal overflow / cut-off content at 390px width. | page (browser @ 390x844): home + one camp detail; check `scrollWidth <= clientWidth`. | No horizontal scroll; primary actions reachable. |
| **M2** | Valid installable manifest. | cmd: `curl /manifest.json` and verify `name`, `short_name`, `start_url`, `display`, `theme_color`, `background_color`, and `icons` (192 + 512). | All required fields present and non-empty. |
| **M3** | Viewport + theme-color meta present. | cmd: grep home HTML for `<meta name="viewport"` and `theme-color`. | Both present. |

### F. Empty-state & error-state quality
| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **E1** | Compare page with nothing selected shows a helpful empty state. | page: open `/c/denver/compare` with no selections. | Non-blank, instructive empty state (not a broken/empty grid). |
| **E2** | Zero-result filter/search shows a helpful empty state. | page: apply a filter combo that yields no camps. | Explicit "no camps match" message with a reset path, not a blank list. |

### G. SEO fundamentals
| ID | Item | How to check | Pass criterion |
|----|------|--------------|----------------|
| **S1** | Every page has a unique, non-duplicated `<title>`. | cmd: `curl` in-scope pages; check `<title>` — no repeated brand suffix (e.g. `\| CampFit \| CampFit`). | Each title is clean and unique; no doubled suffix. (Currently FAILS.) |
| **S2** | Meta description + canonical present on key page types. | cmd: grep for `<meta name="description"` and `rel="canonical"` on home + camp detail. | Both present and page-appropriate. |
| **S3** | `robots.txt` and `sitemap.xml` are correct and in sync. | cmd: fetch both; confirm sitemap lists live camp URLs and robots disallows `/dashboard`,`/auth/`,`/api/`. | Both valid; sitemap URL count ≈ live camp count. |
| **S4** | Social share card has an OG image. | cmd: grep home + camp detail for `og:image`. | `og:image` present and returns 200. (Currently FAILS — none declared.) |

---

## Verified-Coverage Threshold — OWNER DECISION (open)

**T3** intentionally has no numeric threshold. Per I20/I21, the % of published
camps that are genuinely VERIFIED (with `lastVerifiedAt`) is the trust floor for
advertising. **Brian to set the number** (e.g. "≥ 60% verified, and 100% of
non-verified camps clearly marked unverified"). Until set, T3 is **BLOCKED on owner
input**, not failed.

## Disqualifying "slop" — owner definition (seeded by the audit)

Open question from #49: *what counts as disqualifying slop?* Seeded from the
2026-07-03 audit, the proposed definition (pending owner confirmation):

- Camp names/descriptions containing scraper/spreadsheet artifacts (stray
  instructions like "see that row", "@ home - Now", dangling punctuation).
- Any placeholder/lorem/TODO/"coming soon" text visible to parents.
- "Verified" shown for data that has no verification date or source.
- Duplicated brand suffixes or obviously templated broken titles.

## Owner Sign-Off

- [ ] Brian has reviewed this bar and confirms it is the finite launch gate.
- [ ] Brian has set the **T3 verified-coverage threshold**: `______%`.
- [ ] Brian has confirmed the disqualifying-slop definition above.

Sign-off recorded on: PR #___ / issue #49 (to be filled at merge).
