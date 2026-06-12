# Driving Session 1 — Survey Review Workbench

**Purpose:** Brian operates the review workbench hands-on with realistic seeded data to see what the Survey primitives actually do. Prep only — no redesign, no debugging required.

---

## (a) Launch

### Prerequisites

`.env.local` must exist with `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `ADMIN_EMAILS` containing your email. These are already set in the repo.

### Steps from a clean checkout

```sh
# 1. Install dependencies (skip if node_modules already exists)
npm install

# 2. Seed the 6 driving-session proposals (idempotent — safe to re-run)
npm run seed:driving-session

# 3. Start the dev server
npm run dev

# 4. Open http://localhost:3000/auth/login
#    Sign in with your Supabase credentials (brian.anderson1222@gmail.com)

# 5. Navigate to the review queue
open http://localhost:3000/admin/review
```

You will see 6 proposals tagged `driving-session-1` in the queue (plus any other pending proposals already in the database). Each has 2 field proposals inside it.

**One-liner golden path:**
```sh
npm install && npm run seed:driving-session && npm run dev
# then: http://localhost:3000/admin/review
```

**Auth note:** The admin review area requires Supabase login. No local bypass exists — the Supabase project is live and your email (`brian.anderson1222@gmail.com`) is listed in `ADMIN_EMAILS`. Login takes under 10 seconds.

---

## (b) The Drive

Work through 5 of the 6 seeded proposals in order. Suggested sequence:

| # | Camp | Intent |
|---|------|--------|
| 1 | Aerial Cirque Over Denver | Accept both fields — description populate (conf 0.96) + phone populate (conf 0.94). Clear yes. |
| 2 | Altitude All Sports | Accept `registrationStatus` (conf 0.97, clear excerpt). **Keep current** `ageRange` — "For all ages" is too vague. Type a rationale: *"Excerpt too generic — keeping until source specifies age bands."* |
| 3 | Apex Music Camp | Accept both — description and email were empty, both high confidence. |
| 4 | Art Garage | **Ambiguous.** `registrationStatus` OPEN→WAITLIST at conf 0.68. The excerpt says "join the waitlist" but the page also lists open slots. Decide either way; leave undecided or accept depending on your read. |
| 5 | Art Camp with Matty Miller | Accept name cleanup + email. Both obviously right. |
| 6 | Avid 4 Adventure | (Optional) Keep current on `description` — the proposed rewrite is wordier but adds nothing. Good keep-current example. |

**Minimum to demonstrate all primitives:**

1. Click into proposal 1 → accept both fields (no rationale needed — click Accept, then click "Apply Survey decisions")
2. Proposal 2 → accept registrationStatus, keep-current ageRange, **type a rationale** in the note box before submitting
3. Proposal 4 → leave one item undecided (don't click anything on registrationStatus) to see what the "unresolved" state looks like

---

## (c) Five Things to Notice

### 1. Every decision carries collection provenance (authorizing block)

**Where to see it:** After you submit decisions and apply a proposal, call:

```
GET http://localhost:3000/api/admin/review/<proposalId>/survey-events?reviewSessionId=<sessionId>
```

You get the sessionId from the page URL or from the `SurveyReviewSession` table. In the JSON response, find events where `spec.eventType === "decision-submitted"`. Each one contains:

```json
{
  "spec": {
    "eventType": "decision-submitted",
    "data": {
      "authorizing": {
        "kind": "authorized-action",
        "promptRef": "survey://campfit/approve-field@v1",
        "action": "typed",           // ← "typed" if you wrote a note; "affirmed-control" if you just clicked
        "authorityRef": "campfit-reviewer:brian.anderson1222@gmail.com"
      }
    }
  }
}
```

Direct DB query:
```sql
SELECT event->'spec'->'data'->'authorizing'
FROM "SurveyReviewEvent"
WHERE event->'spec'->>'eventType' = 'decision-submitted';
```

The `authorizing` block is the proof that a human made this decision, how (click vs. typed), and who. This is what makes the downstream TrustBundle admissible.

### 2. Events are append-only (the event stream grows)

**Where to see it:** The `SurveyReviewEvent` table. Each workbench interaction appends to it — decisions are not edited in place. Check before and after making decisions:

```sql
SELECT sequence, "eventType", "occurredAt", rationale
FROM "SurveyReviewEvent"
WHERE "proposalId" = '<proposalId>'
ORDER BY sequence ASC;
```

You'll see events like `session-started` → `item-selected` → `decision-changed` → `note-changed` → `decision-submitted`. The sequence column is the immutable ordering. Nothing is ever deleted or updated during normal review.

On the review page itself, the "Saved Survey decisions" panel (data-testid `survey-review-trail`) shows the live event stream as you interact.

### 3. Decisions project into a TrustBundle

**Where to see it:**

After applying a proposal (clicking "Apply Survey decisions" → confirm), the approve route calls `buildCampReviewTrustInput` which produces a `TrustBundle`. To inspect the full claim set:

```sh
# Verify the trust integration end-to-end (uses fixture data, prints claim count):
npm run verify:survey

# Inspect a live trust bundle from a real proposal by running the integration script with your proposalId:
npm run verify:survey-apply
```

The `verify:survey` script (`scripts/verify-survey-integration.ts`) calls `buildCampReviewTrustInput` with a fixture proposal and prints the resulting trust report. Each approved field becomes a `scalarField` claim with `status: "verified"`. Each rejected field becomes a `scalarFieldCandidate` claim with `status: "rejected"`. The `metadata.survey` block on every claim contains `candidateSetId`, `candidateId`, and `reviewOutcomeId` — the full provenance chain.

The `authorizing.action` value you saw in point 1 flows into the `reviewOutcome.authorizing` field on the claim, which is what a trust consumer checks to verify this was a real human decision.

### 4. typed vs affirmed-control is recorded

**Where to see it:** Same event query as point 1, but compare two decisions from your session:

```sql
SELECT
  event->'spec'->'rationale' AS rationale,
  event->'spec'->'data'->'authorizing'->>'action' AS action
FROM "SurveyReviewEvent"
WHERE event->'spec'->>'eventType' = 'decision-submitted'
  AND "proposalId" IN (
    SELECT id FROM "CampChangeProposal"
    WHERE 'driving-session-1' = ANY("feedbackTags")
  );
```

After your session:
- The Altitude All Sports decision where you typed a rationale will show `"action": "typed"`
- The Aerial Cirque decision where you just clicked Accept will show `"action": "affirmed-control"`

Both are valid. The difference matters to oversight consumers — `typed` means the reviewer made an explicit textual claim; `affirmed-control` means they clicked a UI control without additional comment. Trust downstream policy can require `typed` for high-impact fields.

### 5. Oversight metrics are derivable from your session

**Run this after completing your review:**

```sh
node scripts/session-metrics.mjs
```

This reads your actual `SurveyReviewEvent` rows for the `driving-session-1` proposals and prints:

```
typedRationaleRate : 20%  (1/5 decisions had typed rationale)
overrideRate       : 20%  (typed action / total)
```

These are YOUR numbers from YOUR session. `typedRationaleRate` tells you what fraction of decisions you added a note to. `overrideRate` is the same signal from the authorizing block's perspective — a signal that matters to compliance consumers asking "did the operator just rubber-stamp everything?"

The metrics script only reads your `SurveyReviewEvent` table rows — it doesn't make any API calls. Run it immediately after finishing the review to see your personal oversight profile.

---

## (d) Friction Log

Fill this in as you go. These are pre-found friction points from the prep run — add yours below.

| Step | Confused by | Expected | Got |
|------|-------------|----------|-----|
| Login | — | — | — |
| Finding proposals in queue | Queue shows ALL pending proposals, not just ds1 ones | Filter by tag ds1 | Must scroll or use browser Find to locate ds1 proposals |
| Survey workbench location on review page | — | — | — |
| Submitting decisions | — | — | — |
| Seeing the event trail | — | — | — |
| Apply Survey decisions | — | — | — |
| Running session-metrics.mjs | — | — | — |

**Pre-found frictions (from prep run):**

1. **Queue doesn't filter by tag.** The `driving-session-1` proposals are mixed into the full pending queue. You can use the URL filter `?campId=...` per proposal or just navigate directly to each proposal URL. A `?feedbackTag=driving-session-1` filter does not yet exist on the queue page.

2. **authorizing block requires browser.** The `action: "typed" | "affirmed-control"` field on `spec.data.authorizing` is only populated by the browser workbench component — it is not set when events are injected programmatically (e.g., via the dry-run script). You must use the actual browser UI to see it.

3. **Session metrics are approximate pre-apply.** The `session-metrics.mjs` script computes `typedRationaleRate` from rationale presence on decision-submitted events. The `overrideRate` precision improves once decisions are submitted via the browser (which sets the authorizing block). Running the script before applying the proposal gives useful but slightly underspecified numbers.

4. **`deriveOversightMetrics` is not yet in @kontourai/survey 0.5.2.** The metrics script is hand-rolled from the event stream. When the SDK ships `deriveOversightMetrics` the script can be simplified to a single call.

---

## Quick Reference

| Item | Value |
|------|-------|
| Dev server URL | http://localhost:3000 |
| Review queue | http://localhost:3000/admin/review |
| Survey fixture (no auth needed — static render) | http://localhost:3000/admin/review/survey-fixture |
| Seed command | `npm run seed:driving-session` |
| Metrics command | `node scripts/session-metrics.mjs` |
| Verify trust integration | `npm run verify:survey` |
| Verify review items | `npm run verify:survey-review-items` |
| Supabase project | https://rpnzolnnhbzhuspwpajq.supabase.co |
| Admin email | brian.anderson1222@gmail.com (in ADMIN_EMAILS) |
