# Traverse adjudication — glm-5.2 via Z.AI (Slice 2b, 2026-07)

Adjudicates the LIVE parity run that pointed `@kontourai/traverse` (schema
`CAMP_TARGET_SCHEMA`) at three sources through the datum `extraction-default`
role (`glm-5.2@zai`, provider `anthropic-extraction-provider:glm-5.2@api.z.ai`).

- Parity run: `artifacts/traverse-parity/2026-07-03T00-21-51-192Z/` (gitignored; snapshots captured
  under `.kontourai/campfit/snapshots/` via `fetchAndExtract` `live-with-capture`).
- Each surviving proposal's `excerpt` is provenance-verified by traverse (it
  occurs verbatim in the prepared page text and its `chars:<a>-<b>` locator
  slices out exactly that excerpt) — so adjudication below judges **factual
  correctness**, not whether the excerpt exists.
- **Method:** for every proposal, the excerpt was checked against the captured
  snapshot bytes and the value judged `correct` (a real, correctly-typed fact for
  the entity), `ambiguous` (value traces to the page but is composed/mislabeled
  in a way a reviewer could be misled by), or `incorrect` (not supported / wrong).

> Note on scope: the original 2026-07-02T21-00-11 parity artifacts recorded only
> aggregate agreement — no per-proposal excerpts/values were persisted, so those
> exact 18 proposals could not be re-inspected. Slice 2b fixed that gap: the
> parity harness now persists full proposals + a byte-identical snapshot per
> source, and this adjudication is over that re-run (18 surviving proposals:
> avid4 4, denver-art-museum 9, idtech 5). glm-5.2 is non-deterministic, so the
> per-source proposal counts differ run-to-run.

## Verdict summary

| Source | Proposals | correct | ambiguous | incorrect | Dropped (pre-survival) |
| --- | --- | --- | --- | --- | --- |
| avid4 | 4 | 3 | 1 | 0 | 14 (indexed-path drift) |
| denver-art-museum | 9 | 7 | 2 | 0 | 2 (fabricated excerpt) |
| idtech | 5 | 4 | 1 | 0 | 0 |
| **Total** | **18** | **14** | **4** | **0** | **16** |

**Headline:** zero surviving values were outright fabricated — traverse's
verbatim-excerpt gate dropped every value glm-5.2 could not anchor to the page
(2 on Denver). But **4 of 18 surviving values are "plausible-but-wrong-shaped"**,
which is the failure mode the brief flags as worse than silence: not invented
facts, but real page fragments **stitched into a misleading record** (age ranges
composed across unrelated bands; a season span presented as one session; a page
title presented as a camp name). These pass provenance and confidence gates
(mean conf 0.90–0.94) yet a reviewer must catch them.

## Per-proposal adjudication

### avid4 — `https://avid4.com/day-camps/colorado/` (301 → `/golden-colorado-summer-camps`)
Legacy: 0 camps ("No program cards found"). Traverse read the redirect target
(a Golden category landing page), captured at status 200.

| Field | Value | Verdict | Note |
| --- | --- | --- | --- |
| name | "Avid4 Adventure Golden, Colorado Summer Camps" | ambiguous | The page `<title>`, not a specific program; defensible as source-level identity for a category landing page, but not an individual camp name. |
| description | "Experience the power of the great outdoors…keep coming back to." | correct | Verbatim marketing paragraph; accurate. |
| category | MULTI_ACTIVITY | correct | Page says "several single sport and multisport day camp options" — reasonable enum choice. |
| city | "Golden" | correct | Real city (camps are in Golden). **Better than legacy**, which hardcodes `city: "Denver"`. |

**Critical finding (path-format drift):** glm-5.2 additionally emitted 14
proposals on **indexed** paths — `schedules[0].startDate`, `ageGroups[0].minAge`,
etc. — instead of the schema's array convention `schedules[].startDate`. Traverse
dropped all 14 as "unknown fieldPath (not in targetSchema)". Consequence: **avid4
lost 100% of its schedule and age data** to path-shape drift, not to a missing
fact. This is a reliability risk distinct from hallucination.

### denver-art-museum — `https://www.denverartmuseum.org/en/summer-camps`
Legacy: 1 camp ("About Summer Camps"). Traverse: 9 surviving proposals.

| Field | Value | Verdict | Note |
| --- | --- | --- | --- |
| name | "Denver Art Museum Summer Camps" | correct | From page title "Summer Camps | Denver Art Museum". |
| city | "Denver" | correct | Agrees with legacy. |
| registrationStatus | OPEN | correct | Excerpt "Summer Camps are now on sale!" → OPEN is a sound inference. |
| pricing[].amount | 400 | correct | "Full day camps are $400 for members, $450 for nonmembers" — member price. |
| pricing[].amount | 450 | correct | Same excerpt — nonmember price. |
| ageGroups[].minAge | 5 | correct | Excerpt "For Campers Ages 5-6". |
| ageGroups[].maxAge | 17 | **ambiguous** | Pulled from a **different band** ("ages 15-17" teen workshops), not the 5-6 band the minAge came from. Composed range 5–17 describes **no actual camp** — cross-band stitching. |
| schedules[].startDate | 2026-06-08 | correct | "From June 8 to August 7" → season start (year inferred). |
| schedules[].endDate | 2026-08-07 | **ambiguous** | Same excerpt — this is the whole-**season** span (Jun 8–Aug 7) presented as a single ~2-month session, not a discrete weekly session. Value right, semantics misleading. |

Dropped pre-survival (2): `description` and `category` — glm-5.2 returned
paraphrased excerpts that were **not verbatim** on the page, so traverse dropped
them ("excerpt not found in prepared content"). This is the provenance gate
working: paraphrase → drop, not silent accept.

**Denver disagreed compared-field rulings** (this run's 2 disagreements —
`fieldsCompared: 3, agreed: 1`):
1. **name** — legacy "About Summer Camps" vs traverse "Denver Art Museum Summer
   Camps". **Traverse is more correct**: legacy grabbed an interior section
   heading; traverse resolved the page's actual title.
2. **registrationStatus** — legacy UNKNOWN vs traverse OPEN. **Traverse is
   correct**: "now on sale" supports OPEN; legacy's selector never reads status
   and defaults UNKNOWN.

### idtech — `https://www.idtech.com/courses` (healthy source)
Legacy (JSON-LD scraper): 23 courses. Traverse: 5 proposals (single page-level
entity). This is the first source where field agreement on a **working** legacy
baseline is measurable.

| Field | Value | Verdict | Note |
| --- | --- | --- | --- |
| name | "iD Tech Coding Classes for Kids & Teens" | ambiguous | Page/brand title, not one course. Legacy's first row is the specific "Coding 101 Camp". |
| description | "With more than 70 summer and after-school courses…" | correct | Accurate site-level description (verbatim). |
| category | STEM | correct | Agrees with legacy. |
| ageGroups[].minAge | 7 | correct | "Ages 7 - 9". Agrees with legacy. |
| ageGroups[].maxAge | 19 | correct | From "Ages 13 - 19". iD Tech's true provider-wide max is 19, so the composed 7–19 **envelope is correct** here — but note it is the same cross-band stitch that mislead on Denver; it just happens to land on the real global max. |

## Field-agreement on the healthy source (criterion 4)

Comparing legacy `camps[0]` (Coding 101 Camp) vs traverse's single page-level
proposal, `fieldsCompared: 5, agreed: 2`:

| Field | Legacy (per-course) | Traverse (per-page) | Agree? | Cause of disagreement |
| --- | --- | --- | --- | --- |
| category | STEM | STEM | ✅ | — |
| ageGroups[].minAge | 7 | 7 | ✅ | — |
| ageGroups[].maxAge | 9 | 19 | ❌ | granularity: course (7-9) vs provider envelope (7-19) |
| name | "Coding 101 Camp" | "iD Tech Coding Classes for Kids & Teens" | ❌ | granularity: one course vs page title |
| description | course blurb | site blurb | ❌ | granularity: course vs page |

**Interpretation:** the two AGREE on every genuinely page-level field (category,
min age). All three disagreements are **granularity artifacts**: the legacy
JSON-LD scraper enumerates 23 per-course rows while the single-entity
`CAMP_TARGET_SCHEMA` makes traverse collapse the listing into one page-level
record. This is **not** a traverse accuracy failure — it is a schema-shape
mismatch. The measured 2/5 agreement **understates** correctness; on a
like-for-like (page-level) comparison the disagreements dissolve.

## Observed glm-5.2 quality characteristics

1. **No surviving hallucinations.** Every value glm-5.2 could not anchor to a
   verbatim page excerpt was dropped (Denver ×2). The provenance gate is load-
   bearing for this model.
2. **High, flat confidence (0.90–0.94 mean).** Confidence does **not**
   discriminate the ambiguous/misleading proposals from the correct ones — the
   cross-band age stitches carried conf 0.90–0.95. Confidence is not a usable
   quality filter for this model on this schema.
3. **Cross-entity / cross-band stitching is the dominant risk.** On listing
   pages with multiple age bands or sessions, glm-5.2 composes one record by
   pulling each field from whichever fragment maximizes it, yielding
   real-but-incoherent ranges (Denver 5–17; idtech 7–19). Worse than silence
   when the composed range looks plausible.
4. **Array-path convention is not reliably honored.** glm-5.2 emitted concrete
   indices (`schedules[0].startDate`) that fall outside the `[]` schema paths and
   were dropped, silently losing all of avid4's dates/ages. A path-normalization
   step (accept `[n]` → `[]`) would recover these — noted as a follow-up.
5. **Page-level vs entity-level granularity.** The single-entity schema makes
   traverse return one page-level record; on multi-item listings it does not
   enumerate items, so a healthy per-item legacy scraper will always "disagree"
   on identity fields. Per-item extraction is a schema-design follow-up, not a
   model defect.

## Summary verdict

glm-5.2 via Z.AI is **safe to run behind review** for the selector-dead sources
(avid4, denver-art-museum): it recovers real facts those scrapers can no longer
read, and its worst surviving errors are structural (composed ranges, page-title-
as-name) that a reviewer can catch — it did not invent facts. It is **not yet a
drop-in replacement** for a healthy per-item scraper: the single-entity schema +
cross-band stitching mean it under-enumerates and can mis-compose ranges. Net
recommendation (see `traverse-pilot.md` decision record): **traverse primary
behind a flag for selector-dead sources with legacy in shadow; healthy sources
stay legacy-primary until a per-item schema + a stitching guard close the two
structural gaps above.**
